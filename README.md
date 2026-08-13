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

### The budget is part of the interface

The free plan allows **10,000 neurons per rolling 24 hours** and then hard-fails. An app about
showing its own machinery should not hide the one constraint that decides whether it answers at
all, so the header carries a live gauge and a blocked question explains itself instead of
surfacing a raw `4006`.

The figures come from Cloudflare's `aiInferenceAdaptiveGroups` analytics dataset — the same source
the dashboard uses. Nothing is estimated from token counts, so nothing drifts.

**Two numbers disagree, and the reassuring one is wrong.** The limit is enforced over a rolling
24-hour window; the Cloudflare console shows a calendar-day counter that resets at 00:00 UTC.
Measured on this account while every request was failing:

| | |
|---|---|
| calendar-day usage (what the console shows) | 2,492 / 10,000 |
| trailing 24h (what is enforced) | **10,681 / 10,000** |

Nothing in the console indicates the two differ. The gauge reports the enforced window and
projects recovery by ageing hourly buckets out of it, which on that day was roughly four hours
earlier than the implied midnight reset.

*Caveat:* analytics aggregate with a short lag, and enforcement counters appear to lag as well —
a burst can overshoot before the limiter catches up, which is how a 2,500-neuron recording
completed against ~1,800 of headroom. The gauge is reliable for planning and approximate at the
very margin.

### Latency by stage (p50 / p95, ms)

| embed | retrieve | generate | judge | total |
|---|---|---|---|---|
| 309 / 497 | 18 / 30 | 1247 / 2355 | 2497 / 6628 | 3390 / 6621 |

The judge dominates. It runs after the answer has fully streamed, so it never delays reading.

**Read the p95 column with suspicion — this one included.** It is computed from 28 single-shot
samples in one recording, which makes it closer to "the second-slowest case that day" than to a
property of the system. Recording the same 28 cases again against the same deployment measured a
judge p95 of **62,503 ms** against the 6,628 above, and a total p95 of 24,505 against 6,621 —
while p50 moved only from 3,390 to 3,716. The median is stable across runs; the tail is not,
because `gpt-oss-20b` has a heavy one. Both recordings time each stage inside the Durable Object,
so that spread is inference latency rather than a client's network path.

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
- **Two CI tiers, answering different questions.** Tier 1 runs on every PR — typecheck, unit
  tests, corpus integrity, and the evaluation **replayed from committed fixtures** against
  `eval/floors.json`. No credentials and no model calls, so it runs on forks and **blocks the
  merge**. It asks: *did this change move the numbers?*
- **Tier 2 runs weekly against the deployed Worker** and asks a different question: *has the
  deployed system drifted since the baseline was recorded?* It records fresh, replays against the
  same floors, fails if one breaks, and writes the run to D1 history. It does **not** propose
  fixture updates on a schedule — fixtures carry per-stage timings that differ on every run, so a
  nightly PR would fire every night and be almost entirely noise. Refreshing the recorded baseline
  is deliberate: dispatch the workflow with `refresh_fixtures`, or run `npm run eval:record`.
  Weekly rather than nightly because the deployment is fixed — day-to-day quality drift is
  unlikely, while a daily recording reliably contended for the same free allocation the live page
  draws on.
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

## Conversations — what it does and doesn't do

**Multi-turn context: yes, bounded.** Follow-ups resolve against earlier turns — ask "how long is
that lock?" after a question about registrant changes and it carries the referent. The last
**four messages** (two exchanges) are replayed to the model, deliberately: history competes with
retrieved passages for a 24,000-token context window, and the passages are what ground the
answer. Beyond two exchanges back, earlier turns are stored and displayed but not fed to the
model.

Refusals are stored and shown but **never replayed as context**. A similarity-gated refusal never
reached the model, and a sentinel refusal was a token rather than prose, so replaying either as
prior assistant output would invent history the model never produced — and bias it toward
refusing again.

**Resetting: yes.** *New chat* in the header deletes the conversation, its per-turn traces, and
its evaluation history from Durable Object storage, then takes a fresh session id. Deleting
server-side is the point: dropping the id alone would leave the old object's rows in place, still
readable by anyone holding that id, since there is no authentication in front of it. Deletion is
permanent — evidence and verdicts for past turns go with it.

**Multiple simultaneous chats: no.** One conversation per browser, keyed by a single
`localStorage` entry. Nothing in the backend prevents it — every session id already gets its own
Durable Object, and the evaluation suite runs 28 of them concurrently — so this is a missing
interface, not a missing capability. Starting a new chat ends the previous one.

**Sharing or resuming a conversation elsewhere: no.** The session id never appears in the page
URL, so a link carries nothing. Opening the site in another browser or a private window starts
empty.

## MCP server — the same evidence, for agents

**Endpoint:** `POST https://glassbox.glassbox.workers.dev/mcp` · **Call log:**
[`/api/mcp/history`](https://glassbox.glassbox.workers.dev/api/mcp/history)

The corpus, the retrieval scores, and the evaluation history are reachable over the Model Context
Protocol, so an agent can investigate this system the way the browser panel lets a person do it.
Answers arrive with their evidence attached, not as prose to be taken on trust.

| Tool | Scope | Cost | What it returns |
|---|---|---|---|
| `glassbox_retrieve` | read | ~0.07 neurons | Passages and cosine similarity scores, no generation. Reports whether the top score clears τ. |
| `glassbox_compare_runs` | read | free | Two evaluation runs diffed — metric deltas **and the specific cases** whose refusal, reason, faithfulness, or retrieval rank changed. |
| `glassbox_list_eval_cases` | read | free | The 28 committed cases, read from the same `eval-set.jsonl` the harness measures against. |
| `glassbox_budget` | read | free | The live allocation, over the window that is actually enforced. |
| `glassbox_ask` | **full** | ~100 neurons | Answer + evidence + judge verdict + per-stage latency. |

### The scope boundary is cost, not secrecy

Everything here is public documentation and already-published numbers. There is nothing to
withhold. What is scarce is 10,000 neurons per rolling 24 hours, shared with the live page — so
the privileged scope holds exactly the tools that spend it, and `glassbox_ask` is the only one.
`tools/list` is scope-filtered, so a read-scoped agent is never shown a tool it would be refused
for calling.

The rate limit (20 successful `glassbox_ask` calls per rolling hour) is a `COUNT` over the same
`mcp_calls` rows the history endpoint publishes, not a private counter — so the limit can be
audited instead of trusted. A privileged call also pre-checks the budget and declines with the
projected recovery time rather than failing upstream.

### Two protocol eras, because one would connect to nothing

MCP revision **2026-07-28** removed the `initialize` handshake, protocol sessions, the GET stream,
server-initiated requests, and stream resumability; a modern request carries its version and
capabilities in `_meta`, mirrored into headers the server must validate against the body. That
rewrite is why a stateless Worker is a good host for this.

It is also a trap: the specification's compatibility matrix states that a legacy client against a
modern-only server **fails**, with no fall-forward — and every client shipping today opens with
`initialize`. So the server answers both, selecting from how the client opens. Verified live:

| Client opens with | Served as | Result |
|---|---|---|
| `_meta` + `MCP-Protocol-Version` | modern, stateless | ✅ |
| `initialize` | legacy handshake | ✅ |
| `GET` / `DELETE` (old session and stream mechanics) | — | `405`, as specified |
| Header disagreeing with body | — | `400` + `-32020` |
| Unsupported version | — | `400` + `-32022` with the supported list |

No SDK. The server transports in `@modelcontextprotocol/sdk` are Node-shaped and lag the revision,
and the Workers-native `McpAgent` would put a framework at the centre of the one surface whose
correctness most wants demonstrating — see [`docs/DESIGN.md`](docs/DESIGN.md) Decision 9. The
protocol is 49 free unit tests over pure `(headers, body)` logic in Tier 1, plus a 21-check live
smoke test.

## Known limitations

Stated plainly, because a project about honest measurement should be honest about itself.

- **Per-turn neuron cost is estimated, not billed — though the estimate has now been checked
  once.** The figure in the evaluation panel is computed from the token counts Workers AI returns
  times published per-model rates, not read back from Cloudflare's billing. (The header gauge is
  the opposite: measured from analytics, never estimated.) Because those are independent paths,
  they can be compared. A live recording started against an empty rolling window reported
  **2,482.2** neurons from token counts while `aiInferenceAdaptiveGroups` measured **2,482.3** for
  the same window. One comparison at one workload is not a calibration, and a differently shaped
  workload could still diverge — but on this one the derived figure is not drifting.
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
- **The free allocation is shared between the demo and its own test suite.** A full recording
  costs ~2,500 of the 10,000 neurons, and once the allowance is gone every request hard-fails —
  the live page included. The recording is weekly rather than nightly for this reason, and it
  stops and warns rather than failing when the budget is already spent, so a budget condition
  never raises the same alarm as a real regression. On a busy day the page can still run out; when
  it does, the page says so and projects when it returns.
- **The MCP server's modern path is specification-tested, not client-tested.** This is the
  uncomfortable one. Revision `2026-07-28` is new enough that no widely-available client speaks it
  yet, so the modern era is verified against the written specification and this repository's own
  conformance suite — which is exactly the circular check the rest of this project argues against.
  The path real clients will actually take today is the *legacy* handshake, which is the less
  interesting half of the implementation. Until a modern client exists to test against, treat the
  ✅ in the era table as "conforms to the spec as read", not "known to interoperate".
- **The MCP server implements tools only, and only unary tools.** No resources, no prompts, no
  streamed tool output: `subscriptions/listen` and the multi-round-trip input requests that
  replaced server-initiated sampling are not implemented. A tool that wanted to report progress
  mid-call could not. Nothing in the surface needs it yet, which is why it is absent.
- **MCP auth is a shared bearer token per scope, not OAuth.** There is no per-user identity, so
  the call log attributes a call to a scope and never to a caller, and revoking access means
  rotating a secret everyone shares. The rate limit is correspondingly global rather than
  per-client — one noisy holder of the full token can consume the hourly allowance for all of them.
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
