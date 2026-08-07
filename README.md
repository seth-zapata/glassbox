# glassbox

**A glass-box RAG agent on Cloudflare Workers — it refuses to guess, and shows you the evidence
and the numbers either way.**

**Live:** https://glassbox.glassbox.workers.dev

Every number below is reproducible with `npm run eval:replay` against committed fixtures — no
credentials and no model calls required.

---

## What it is

A question-answering agent over a small, fixed corpus of **domain-registration policy** —
registrar transfer rules, EPP status codes, grace periods, RDAP. It runs entirely on Cloudflare:
Workers, Durable Objects, Workers AI, Vectorize, and D1.

The part that isn't a normal chatbot: **every answer ships with its evidence.** The UI streams
the retrieved chunks and their similarity scores *before* the answer text, then a second model's
verdict on whether the answer is actually supported by those chunks, then per-stage latency. The
same code path runs headless as a committed evaluation suite, so the numbers in this README come
from a command anyone can re-run.

## Results

28 committed cases, τ = 0.62. Reproduce with `npm run eval:replay`.

| bucket | n | refusal | false-refusal | faithfulness | hit@6 | MRR |
|---|---|---|---|---|---|---|
| in-corpus factual | 12 | — | **0.0%** | **1.000** | 1.000 | 0.861 |
| out-of-corpus | 8 | **100.0%** | — | — | — | — |
| ambiguous | 5 | — | — | 0.875 | — | — |
| adversarial | 3 | — | 0.0% | 1.000 | 0.667 | 0.444 |

Refusal rate alone is meaningless — an agent that refuses everything scores 100%. It is only
informative next to the false-refusal rate it trades against.

### Scope — and why an in-house question still gets refused

The corpus is **Cloudflare Registrar documentation only**. Asking *"how do I configure Workers
KV namespaces?"* is refused, and that is the design working rather than failing.

The generator knows what Workers KV is from pretraining. If it answered, the reply would appear
directly above an evidence panel showing six retrieved chunks about **domain transfers** — fluent,
confident, and completely ungrounded. That is precisely the failure this project exists to make
visible, and it is worse than a refusal because it *looks* sourced.

It is also the hardest refusal to get right: same company, same documentation site, plainly
adjacent. It scored **0.596**, the closest match in a registrar corpus to a question about a
storage product. That case is `oc-01` in the eval set for exactly this reason.

Refusals name the boundary rather than just reporting a threshold, so a dead end becomes a
redirection.

### The interesting result: similarity alone cannot do this

There are two refusal gates — a similarity threshold, and a sentinel the model emits when the
retrieved passages do not actually answer the question. Sweeping the threshold shows it
contributes **nothing** to refusal quality:

| τ | out-of-corpus refused | in-corpus wrongly refused |
|---|---|---|
| 0.45 – 0.65 | 100% | 0% |
| 0.70 | 100% | 8.3% |
| 0.85 | 100% | 33.3% |

Because the score distributions **overlap**. The highest-scoring out-of-corpus question (0.757,
*"what is Cloudflare's refund policy for enterprise contracts"*) outranks the lowest-scoring
in-corpus one (0.683, *"what is an authorization code"*). No threshold separates them.

At τ = 0.62, of eight out-of-corpus questions the similarity gate catches **two**; the sentinel
gate catches **six**. A similarity-only design would have let six of eight through to
generation and answered them.

So the threshold is not a correctness control — it is a **cost** control. A similarity refusal
costs 0.09 neurons and ~477 ms; a sentinel refusal costs a full generation, ~100 neurons and
~4.5 s. τ is set as high as it can go without causing false refusals.

### Latency by stage (p50 / p95, ms)

| embed | retrieve | generate | judge | total |
|---|---|---|---|---|
| 309 / 497 | 18 / 30 | 1247 / 2355 | 2497 / 6628 | 3390 / 6621 |

The judge dominates. It runs after the answer has fully streamed, so it never delays reading.

---

## Required components → where they live

| Required | Implementation | Where |
|---|---|---|
| **LLM** | Workers AI — `llama-3.3-70b-instruct-fp8-fast` (generation), `bge-base-en-v1.5` (embeddings), `gpt-oss-20b` (judge, deliberately a different family) | [`generate.ts`](src/agent/generate.ts), [`judge.ts`](src/agent/judge.ts) |
| **Workflow / coordination** | **Durable Objects** — one instance per session, orchestrating retrieve → gate → generate → gate → judge | [`ChatAgent.ts`](src/agent/ChatAgent.ts) |
| **User input** | Text chat with a live evaluation panel, served from Workers static assets | [`public/index.html`](public/index.html) |
| **Memory / state** | **DO SQLite** for conversation history and per-turn traces; **D1** for evaluation history across deploys — see [`/api/eval/history`](https://glassbox.glassbox.workers.dev/api/eval/history) | [`ChatAgent.ts`](src/agent/ChatAgent.ts), [`evalStore.ts`](src/agent/evalStore.ts), [`migrations/`](migrations/) |
| *Optional* | **Vectorize** — 70 chunks over 18 committed documents | [`retrieve.ts`](src/agent/retrieve.ts), [`ingest.ts`](src/agent/ingest.ts) |

Full rationale, rejected alternatives, and the platform research behind each choice are in
[`docs/DESIGN.md`](docs/DESIGN.md).

---

## Running it

Requires Node 22+ (see `.nvmrc`) and a Cloudflare account on the free plan.

```bash
npm install
npm run login          # OAuth; prints a URL rather than opening a browser
npm run whoami         # confirm authentication
```

> **Note for WSL users:** `wrangler login` binds `127.0.0.1:8976` and does not auto-open a
> browser here, so `npm run login` prints the URL for you to paste. The credential is written
> *after* the browser shows its success page — let the command exit on its own rather than
> interrupting it, or the token is never persisted.

---

## Development workflow

This repository is also a demonstration of a continuous-integration workflow, so the process is
part of the deliverable rather than incidental to it.

- **`main` cannot be committed to directly.** A branch ruleset requires a pull request and a
  passing `verify` check; a direct push is rejected with `GH013`. Force-pushes and branch
  deletion are blocked too.
- **Two CI tiers.** Tier 1 runs on every PR — typecheck and a credential scan of the committed
  transcript today, growing to unit tests, eval-set validation, and the evaluation replay gate
  as the code lands. No credentials and no model calls, so it runs on forks and **blocks the
  merge**. Tier 2 runs the live evaluation against real models on demand.
- **CI never claims coverage it doesn't have.** Checks are added alongside the things they
  verify, not written in advance against code that doesn't exist yet.
- **Why the split:** the free-tier allocation is 10,000 neurons/day, and a live evaluation run
  costs roughly 3,700 of them. Running that on every push would exhaust the budget and take the
  deployed demo down with it. A gate that can break the service it guards is not a gate. See
  `docs/DESIGN.md` §2b and Decision 7.

---

## Prompt history

AI-assisted development was used throughout, and the complete session history is part of what
this repository delivers.

```bash
npm run transcript          # render session logs → transcripts/PROMPT_HISTORY.md
npm run transcript:check    # verify no private content survived
```

[`transcripts/PROMPT_HISTORY.md`](transcripts/PROMPT_HISTORY.md) is generated by
[`scripts/export-transcript.ts`](scripts/export-transcript.ts), which is committed — the
rendering is reproducible, not hand-assembled.

**On what was removed.** The history is unsanitized in the way that matters: the wrong turns,
the corrections, and the abandoned approaches are all still there, because those are the parts
that show how the thing was actually built. Two categories are stripped automatically, and every
removal is counted and reported in the generated file:

1. **Credential material** — tokens, keys, account identifiers, OAuth parameters, email addresses.
2. **A private planning document** — a personal document referenced while scoping this project,
   which is not itself about the project. Its contents are removed and each removal is marked
   inline where it occurred.

The literal phrase list driving (2) is gitignored, because publishing it would restate the
content it exists to remove. The rule *categories* and hit counts are published in the generated
transcript, and `npm run transcript:check` fails the build if anything slips through.

---

## Known limitations

Stated plainly, because a project about honest measurement should be honest about itself.

- **Neuron cost is estimated, not billed.** It is computed from the token counts Workers AI
  returns times published per-model rates, not read back from Cloudflare's billing.
- **The eval set is 28 cases, written by the same person who built the system.** That is enough
  to catch regressions and to expose the score-overlap result; it is not a benchmark, and it
  shares an author's blind spots with the thing it measures.
- **The judge is a single model with no human-labelled ground truth.** Faithfulness of 1.000 means
  one model found every claim supported. It failed three separate times during development —
  each time visibly, because the parse fallback never reports "supported" — but a judge that
  agrees with the generator for the wrong reason would not show up here.
- **`gpt-oss-20b` is a reasoning model and a poor fit for a structured-output judge.** It returns
  an undocumented response shape and silently emits nothing when its token budget is short. It
  works now; a non-reasoning judge would be a better choice.
- **Adversarial retrieval is the weakest measured path** — hit@6 0.667 against 1.000 for plain
  in-corpus questions. False premises pull the query embedding away from the passage that refutes
  them. Generation compensated in all three cases; a larger corpus would likely expose this.
- **Ambiguous questions have no automated grade.** Whether a clarifying question is *good* is a
  judgement the harness does not make; those five cases are reported, not scored.
- **One region, one language, no load testing.** Latency figures are single-client from one place.
- **There is no authentication, and the session id is a bearer capability.** Conversations are
  isolated per session — a random id is minted in `localStorage` on first visit, so opening the
  public URL never shows anyone else's history — but whoever holds an id can read that
  conversation. Ids must be 24–64 unguessable characters and there is no shared default, so a
  missing id is rejected rather than pooled. Don't put anything sensitive in it.

## Deliberately not built

Choices rather than gaps: authentication, user accounts, multi-tenancy, voice input, fine-tuning,
a large or dynamic corpus, mobile/responsive layout, and UI polish beyond legible and functional.
The time went into measurement instead.

---

## License

[MIT](LICENSE)
