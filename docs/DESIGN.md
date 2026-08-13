# Design — `glassbox`

**Status:** revised after review — open questions resolved, ready to build
**Date:** 2026-08-06
**Source spec:** a private planning document, kept outside this repository (see README → Prompt history)
**Working dir:** `/home/sethz/projects/glassbox`
**Platform constraint:** Cloudflare **Workers Free plan** — see §2b

---

## 1. What we're building

**Name: `glassbox`.** The opposite of a black box — every answer ships with the machinery that
produced it visible. It names the differentiator rather than the domain, which means it survives
as a portfolio piece after the assignment, and a technical reviewer gets it without explanation.

> **glassbox** — a glass-box RAG agent on Cloudflare Workers. It refuses to guess, and shows you
> the evidence and the numbers either way.


A grounded question-answering agent over a **domain-registration corpus** (Cloudflare Registrar
docs + ICANN domain-lifecycle policy), running entirely on Cloudflare, **that measures its own
correctness in the open**.

Every answer ships with its evidence: which chunks were retrieved, at what similarity, how long
each stage took, and a second model's verdict on whether the answer is actually supported by the
retrieved text. The same measurement path runs headless as a committed eval suite in CI.

The one-line pitch for the README:

> A RAG agent on Workers that refuses to guess — and shows you the numbers proving it.

### Why this corpus

The assignment doesn't pick a corpus. This is the highest-leverage open choice in the whole build, so
it's decided here: **the corpus is domain registration itself.** Registrar transfer policy, EPP
status codes, grace periods (AGP/RGP), redemption and pending-delete, WHOIS/RDAP, DNSSEC DS
records, registrar-of-record vs. reseller.

Three reasons:

1. **The reviewer is on the Registrar team.** A demo that answers "what does
   `clientTransferProhibited` mean and how do I clear it?" is legible to them in five seconds. A
   generic chatbot over generic docs requires them to imagine the relevance.
2. **It has genuinely hard, precise questions.** Domain lifecycle timing (30-day RGP, 5-day AGP,
   60-day post-transfer lock) is exactly the kind of fact an ungrounded LLM confabulates
   confidently and wrongly. That makes the refusal metric *mean* something.
3. **Out-of-corpus questions are natural and unambiguous.** "How do I configure Workers KV?" and
   "What's Cloudflare's stock price?" are obviously outside a registrar-policy corpus, so the
   held-out set isn't arbitrary.

⚠️ **Licensing to verify before committing corpus text** (day 1). ICANN policy documents are
public. Cloudflare's docs have their own license terms. Plan: keep each corpus document short,
attribute every one with a `source_url` in front-matter, and add a `corpus/NOTICE.md`. If
licensing is unclear for any source, paraphrase-and-cite rather than copy.

---

## 2. Platform research — what's verified

All of this was checked against live Cloudflare docs today, not recalled. Findings that change
the design:

| Finding | Detail | Impact |
|---|---|---|
| Llama 3.3 exists and the suggested model is available | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Use it as the generator |
| …but its context window is **24,000 tokens** | $0.29/M in, $2.25/M out | Real constraint — caps retrieved context. Budget ~6 chunks × ~400 tokens |
| Agents SDK is a layer **over** Durable Objects | `Agent` extends DO; `new_sqlite_classes` migration; `this.sql`, `this.setState`, `this.schedule` | Using it still satisfies the "Durable Objects" requirement |
| `AIChatAgent` auto-persists chat history to DO SQLite | `@cloudflare/ai-chat` + `agents` + `ai` packages, `useAgentChat` React hook | Tempting shortcut — but see Decision 1 |
| **AI Search** (formerly AutoRAG) is a managed RAG service | `search()` returns scored chunks with `vector_score` / `keyword_score` / `reranking_score` | Would do our whole retrieval layer. Rejected — see Decision 2 |
| `env.AI.autorag()` binding is **deprecated** | Docs say "no longer recommended" | Don't follow older tutorials |
| Vectorize limits | max **1536** dims; topK **50** with metadata / 100 without; 10 KiB metadata/vector; **10** metadata indexes; 64 B per indexed metadata value | Fits comfortably; the 64 B indexed-metadata cap matters for filter keys |
| Embedding models available | `@cf/baai/bge-base-en-v1.5` (768), `@cf/baai/bge-m3` (1024), `@cf/baai/bge-reranker-base` | A reranker exists on-platform — cheap upgrade path |
| **Pages is legacy for new projects** | Cloudflare's own guidance: start new projects on Workers; all investment goes to Workers static assets | **Deviate from the brief here** — use Workers static assets, not Pages |
| Judge-model diversity is free | `@cf/openai/gpt-oss-120b`, `@cf/qwen3-30b-a3b-fp8`, `@cf/mistral-small-3.1-24b-instruct` all available | Judge with a *different* model than the generator (Decision 5) |

---

## 2b. The free plan is the binding constraint

Confirmed today: **every primitive this design needs works on the Workers Free plan.** Nothing
has to be paid for. But one limit is tight enough to drive architecture.

| Primitive | Free-plan status | Headroom for this project |
|---|---|---|
| Durable Objects | ✅ Available — **SQLite backend only** (KV backend is paid-only) | Fine. We only wanted SQLite. 100k req/day, 100k row-writes/day |
| Vectorize | ✅ "Free tier will always include the ability to prototype" | Huge headroom — 5M stored dims free; our corpus is ~150k |
| D1 | ✅ Available | Huge headroom — 100k row-writes/day; an eval run writes ~30 |
| Workers static assets | ✅ Available | Fine |
| **Workers AI** | ⚠️ **10,000 Neurons/day, then requests hard-fail** | **This is the constraint.** See below |

The DO detail is quietly lucky: free-plan DOs are SQLite-backed *only*, and SQLite is exactly
what this design uses. No change required.

### The neuron budget — the number that shapes the build

Per-turn cost, using published per-model neuron rates:

| Stage | Model | Tokens | Neurons |
|---|---|---|---|
| Embed query | `bge-base-en-v1.5` @ 6,058/M in | ~20 in | ~0.1 |
| Generate | `llama-3.3-70b-fp8-fast` @ 26,668/M in, 204,805/M out | ~2,500 in / ~250 out | ~118 |
| Judge | `gpt-oss-20b` @ 18,182/M in, 27,273/M out | ~2,700 in / ~100 out | ~52 |
| | | **≈ 170 neurons/turn** | |

**10,000 ÷ 170 ≈ 58 answered turns per day, total, across demo *and* CI.**

A full 30-case eval run costs ~3,700 neurons (the 8 out-of-corpus cases refuse at the retrieval
gate and never reach a model, which is free). So: **~2.6 full eval runs per day**, before any
manual demoing. Corpus ingest is a one-time ~120 neurons — negligible.

#### ✅ Measured 2026-08-07 — the estimate above was ~3× pessimistic

Against the deployed skeleton, with a ~1,700-token prompt standing in for six retrieved chunks:

| | Estimated | Measured |
|---|---|---|
| Neurons per generation | ~118 | **40.1** |
| Answered turns/day (generate only) | ~85 | **~249** |
| Full eval run (22 cases reach a model) | ~3,700 | **~880** |
| Eval runs/day | ~2.6 | **~11** |

**The gap is output length, not context size**, and that is the useful finding. Output tokens
cost **204,805 neurons/M against 26,668/M for input — 7.7× more per token.** The estimate
assumed 250-token answers; real answers ran 25–40 tokens. So the dominant lever on cost is how
long the model is allowed to talk, not how much context it is given. For grounded QA that is
nearly free to control: a short-answer instruction plus a `max_tokens` cap costs no quality and
cuts the bill several-fold. Retrieving *more* context is cheaper than answering at length.

**This weakens one of Decision 7's arguments, and the decision should not rest on it.** At ~11
eval runs/day rather than 2.6, a single live run in CI is no longer near-fatal. Record/replay
still stands, on the two reasons that survive measurement:

1. **Fork PRs have no credentials.** A live eval simply cannot run there, so it can never be the
   gate that blocks a merge.
2. **A gate must not be able to exhaust the service it guards.** A busy day is easily 20+ pushes;
   at ~880 neurons each that is still the whole daily budget, and the failure mode is the
   deployed demo hard-failing rather than degrading.

The original "2.6 runs/day" framing overstated the case. Recording the correction rather than
quietly benefiting from a number that happened to point the right way.

⚠️ **Caveat on how this is counted.** `neurons` is computed from the token counts Workers AI
returns, multiplied by published per-model rates. It is not read back from Cloudflare's billing.
Treat it as a well-founded estimate; cross-check against account usage before quoting it as
fact in the README.

Three consequences, all of which improve the design:

1. **The eval suite cannot run live on every PR.** Forced into a record/replay architecture —
   Decision 7. This turns out to be better engineering than what a paid plan would have let me
   get away with.
2. **The judge drops from `gpt-oss-120b` to `gpt-oss-20b`.** Still a different model family from
   the generator, so Decision 5's anti-self-preference property holds, at ~⅓ the neuron cost.
3. **The generator stays Llama 3.3 70B.** It's 70% of the per-turn cost, but it's the recommended
   model and answer quality is the demo. Cut cost elsewhere, not here.

A neuron-spend line goes in the eval CLI output. Reporting your own resource consumption is
on-theme for a self-measuring app, and it's a genuinely useful guardrail against burning the
day's budget before a demo.

---

## 2c. Day-1 verification log

Empirical results, recorded as they land. Assumptions this design rests on, checked rather than
believed.

| # | Assumption | Result |
|---|---|---|
| V1 | Toolchain runs | ✅ Node 22.23.2 via nvm (system Node 18 was below wrangler 4's floor), wrangler 4.120.0 as a devDependency |
| V2 | OAuth login completes on WSL2 | ✅ Callback binds `127.0.0.1:8976`, WSL NAT localhost-forwarding delivers the redirect. Credential at `~/.config/.wrangler/config/default.toml`, mode 600 |
| V3 | **Vectorize is authorized by OAuth** | ✅ **Confirmed by probe.** No `vectorize` scope exists in wrangler's OAuth scope list, which looked like a blocker — but `vectorize list` *and* `vectorize create` both succeed. Covered by the account-level Workers grant. **No API token needed for local dev** |
| V4 | Vectorize index provisions on the free plan | ✅ `glassbox-corpus`, 768 dims, cosine — created and listed |
| V5 | D1 provisions | ✅ `glassbox-evals` created (region WNAM) |
| V6 | Workers AI responds, and neuron accounting matches §2b estimates | ⚠️ **Responds — but the estimate was ~3× pessimistic.** Measured 40.1 neurons where 118 was predicted; output length dominates cost, not context size. See §2b |
| V7 | DO with SQLite deploys and persists | ✅ Turn 2 recalled a fact from turn 1 across separate HTTP requests; `/api/history` returns it on a third; a different session id sees zero messages |
| V8 | **DO → Worker streaming passes through unbuffered** (Decision 1 depends on it) | ✅ **Confirmed.** SSE frames arrive at distinct timestamps, not batched. The `retrieval` event lands **345 ms before the first token** — the progressive reveal works as designed |

All four bindings resolve on the deployed Worker: `CHAT_AGENT` (Durable Object), `DB` (D1),
`VECTORIZE`, `AI`, `ASSETS`. Live at `https://glassbox.glassbox.workers.dev`.

**V8 was the one that could have forced a redesign**, and it passed: a `ReadableStream` returned
from a Durable Object reaches the client incrementally through the parent Worker, so the
hand-rolled SSE protocol in Decision 1 is viable and the fallback (buffer in the DO, stream from
the Worker) is not needed.

**Index committed to:** `glassbox-corpus` · 768 dimensions · cosine. Dimensions are fixed at
creation and cannot be changed, so this locks the embedding model to
`@cf/baai/bge-base-en-v1.5` (768). Switching to `bge-m3` (1024) later would mean recreating the
index — cheap now, but worth knowing it's a one-way door.

**Note for CI:** V3 says nothing about GitHub Actions. Tier 2 uses an API token, not OAuth, and
API tokens *do* have explicit permission groups — so a Vectorize permission still has to be
selected there. Verify separately when wiring Tier 2.

---

Sources: [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) ·
[Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/) ·
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) ·
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) ·
[Agents SDK](https://developers.cloudflare.com/agents/) ·
[Agent API](https://developers.cloudflare.com/agents/runtime/agents-api/) ·
[Chat agents](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/) ·
[Workers AI models](https://developers.cloudflare.com/workers-ai/models/) ·
[Llama 3.3 70B fp8-fast](https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/) ·
[Vectorize limits](https://developers.cloudflare.com/vectorize/platform/limits/) ·
[AI Search binding](https://developers.cloudflare.com/ai-search/usage/workers-binding/) ·
[Workers static assets](https://developers.cloudflare.com/workers/static-assets/) ·
[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)

---

## 3. Architecture

```
                    ┌──────────────────────────────────────┐
   browser ────────▶│  Worker (src/index.ts)               │
   (static assets)  │  · serves ./dist via assets binding  │
                    │  · run_worker_first: ["/api/*"]      │
                    └──────────────┬───────────────────────┘
                                   │ routeAgentRequest()
                                   ▼
        ┌──────────────────────────────────────────────────────────┐
        │  ChatAgent  (Durable Object, one per session id)          │
        │                                                           │
        │  DO SQLite:  messages · turn_traces                        │
        │                                                           │
        │   answerTurn(question):                                    │
        │     1. embed(question) ─────────────▶ Workers AI (bge)     │
        │     2. VECTORIZE.query(topK=6) ─────▶ Vectorize            │
        │     3. ┌─ retrieval gate: maxScore < τ ──▶ REFUSE ─┐       │
        │     4. │  generate(context, history) ──▶ Llama 3.3 │       │
        │     5. │  sentinel gate: INSUFFICIENT_CONTEXT ─────┤       │
        │     6. │  judge(answer, chunks) ──────▶ gpt-oss-120b       │
        │        └───────────────────────────────────────────┘       │
        │     7. persist trace ──▶ DO SQLite                         │
        │     ◀── SSE: retrieval → tokens → judge → done ──────────  │
        └──────────────────────────────────────────────────────────┘
                                   ▲
                                   │ same answerTurn() path
        ┌──────────────────────────┴───────────────────────────────┐
        │  npm run eval  (CLI, scripts/eval.ts)                     │
        │  · reads eval/eval-set.jsonl (committed)                  │
        │  · replays every case through the deployed agent          │
        │  · prints results table, writes eval/results/latest.json  │
        │  · inserts run + per-case rows ──▶ D1                     │
        └───────────────────────────────────────────────────────────┘
```

**The load-bearing property:** the UI and the eval CLI hit **the same code path**. The eval
suite is not a parallel reimplementation that can drift — it's the same `answerTurn()`, called
headlessly. Anything the panel shows, the eval measures, and vice versa.

### The wire protocol — progressive reveal over SSE

The turn streams as four event types, in pipeline order. This is the product surface, not an
implementation detail:

```
event: retrieval   { chunks[], scores[], retrieveMs }   ← panel fills in BEFORE any answer text
event: token       { delta: "..." }                      ← answer streams in
   (or) event: refusal { reason, maxScore, tau }         ← instead of tokens, when gated
event: judge       { supported, score, rationale }       ← verdict arrives after the answer
event: done        TurnResult                            ← full envelope, persisted + returned
```

**Why this ordering is the demo.** Retrieval completes before generation starts, so the evidence
panel can populate *first* — the user watches the agent find its sources, then answer from them,
then get graded. That sequence makes the app's whole thesis legible in about four seconds
without anyone reading the README. A single blocking JSON response would have hidden it.

The eval CLI consumes the same stream and simply waits for `done`, ignoring the intermediate
events. Same code path, no drift.

### The response envelope

`done` carries the complete object — also what `TurnResult` in `src/shared/types.ts` describes:

```ts
type TurnResult = {
  answer: string | null;              // null when refused
  refused: boolean;
  refusalReason: "low_similarity" | "model_declined" | null;
  retrieval: Array<{
    chunkId: string;
    docTitle: string;
    sourceUrl: string;
    score: number;                    // cosine similarity
    text: string;                     // shown in the panel, collapsed
  }>;
  timings: { embedMs: number; retrieveMs: number; generateMs: number; judgeMs: number; totalMs: number };
  judge: { supported: boolean; score: number; rationale: string; model: string } | null;
  models: { generator: string; embedder: string; judge: string };
};
```

---

## 4. Required components → implementation

This table goes in the README verbatim — the assignment requires each component be named.

| Required | Implementation | Where it lives |
|---|---|---|
| **LLM** | Workers AI — `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (generation), `@cf/baai/bge-base-en-v1.5` (embeddings), a second model as judge | `src/agent/generate.ts`, `src/agent/judge.ts` |
| **Workflow / coordination** | **Durable Objects** — one `ChatAgent` DO per session, orchestrating the retrieve → gate → generate → judge pipeline | `src/agent/ChatAgent.ts` |
| **User input** | Text chat UI served via **Workers static assets** (not Pages — see Decision 3) | `src/ui/`, `wrangler.jsonc` `assets` block |
| **Memory / state** | **DO SQLite** for conversation history + per-turn traces; **D1** for eval-run history across deploys | `src/agent/ChatAgent.ts`, `migrations/` |
| *Optional — recommended* | **Vectorize** index over the committed corpus | `src/agent/retrieve.ts`, `scripts/ingest.ts` |

---

## 5. Key decisions

### Decision 1 — Plain `Agent` + our own SSE protocol, not `AIChatAgent`

*(Revised. The first draft cut streaming entirely, on scope-discipline grounds. Overruled on UX
grounds: streaming is what makes an LLM app feel alive, and its absence reads as broken rather
than as minimal. That's a real product argument, and the cut had been
a time-budget guard, not a UX position.)*

`AIChatAgent` gives free history persistence, WebSocket transport, stream resumption, and a React
hook. It is the idiomatic path and it is genuinely less code.

**Still rejected — but the reasoning is now narrower and stronger.** The differentiator is a
structured evidence stream, not a text stream. `AIChatAgent` is built around the AI SDK's
`UIMessage` format; emitting custom `retrieval` and `judge` events means threading AI SDK data
parts through a streaming abstraction I'd be learning simultaneously, and the framework decides
the envelope shape rather than me.

Hand-rolled SSE from a plain `Agent` gets streaming *and* keeps the protocol: ~40 lines of
`ReadableStream` plumbing, four event types I define, and a browser client that's a plain
`EventSource` loop. Workers AI returns SSE natively with `stream: true`, so the token path is
mostly a pass-through.

The cost is ~30 lines of hand-written history persistence via `this.sql` that `AIChatAgent`
would have given free. Worth it to own the wire format, which is the thing being demoed.

⚠️ **Verify day 1:** that a Durable Object can return a streaming `Response` that passes through
the parent Worker without buffering. Expected to work, but it's load-bearing — if it doesn't,
fall back to buffering tokens and streaming only from the Worker layer.

### Decision 2 — Manual Vectorize RAG, not AI Search (AutoRAG)

AI Search would handle chunking, embedding, indexing, and retrieval, and its `search()` even
returns per-chunk `vector_score`, `keyword_score`, and `reranking_score`. It would save
most of day 2.

**Rejected.** Three reasons, in order:

1. **It makes the measured thing a black box.** The entire premise is "this app measures
   itself." If retrieval is a managed service, the honest README sentence becomes "I measured
   Cloudflare's retrieval quality," which is a much less interesting claim than "I built a
   retrieval path and here is where it fails."
2. **Reproducibility.** AI Search indexes from R2 asynchronously. The eval suite's numbers
   would depend on an out-of-band indexing job having converged — bad property for a CI gate.
   A committed corpus + a deterministic `npm run ingest` means anyone can reproduce the numbers.
3. **The threshold is the artifact.** Refusal quality lives in a similarity cutoff I tune
   against a held-out set (§6). I need raw scores from a scoring function I control.

**This rejection goes in the README.** "I evaluated AI Search and chose not to use it, because
X" is exactly the kind of judgment the submitted history should show.

### Decision 3 — Workers static assets, not Pages

The spec says "Pages (or Worker static assets)." Cloudflare's own current guidance is to start
new projects on Workers; Pages remains supported but all new investment goes to Workers static
assets. Single `wrangler deploy`, one config file, one URL, no split between a Pages project and
a Worker. Taking their current recommendation over the older framing.

### Decision 4 — Two-gate refusal, both measured separately

```
gate 1 (deterministic):  max(retrieval scores) < τ  →  refuse, never call the LLM
gate 2 (model):          system prompt restricts to context; model emits
                         INSUFFICIENT_CONTEXT when the passages don't answer the question
```

Gate 1 is cheap, deterministic, and tunable. Gate 2 catches the case where retrieval returns
topically-similar-but-not-answering chunks — the failure mode that produces confident wrong
answers. Reporting which gate fired, and how often each does, is more informative than a single
refusal rate.

### Decision 5 — Judge with a different model than the generator

Faithfulness scoring uses **`@cf/openai/gpt-oss-20b`**, never Llama 3.3 judging its own output.
LLM-as-judge has a well-documented self-preference bias; using the generator as its own judge
inflates the headline number. Different model family costs nothing extra to avoid, and it's a
one-line README note that signals the eval was designed by someone who's shipped one before.

*(Revised from `gpt-oss-120b` — the 20b variant is ~⅓ the neuron cost and still a different
family, which is the property that matters. §2b.)*

### Decision 6 — Report **false-refusal rate**, not just refusal rate

A refusal-rate metric alone is trivially gamed: an agent that refuses everything scores 100%.
So the panel and the eval report a pair:

- **Refusal rate on out-of-corpus questions** — should approach 100%
- **False-refusal rate on in-corpus questions** — should approach 0%

These trade off directly against each other through τ. The eval runner sweeps τ and emits the
tradeoff table; the chosen τ and *why* goes in the README. That table is the single most
convincing artifact in the repo.

### Decision 7 — Record/replay eval, forced by the neuron budget

At ~170 neurons/turn against 10,000/day (§2b), a live eval run costs ~3,700 neurons. Running
that on every push would exhaust the daily allocation in under three pushes and then **hard-fail
every request, including the live demo.** A CI gate that can take down the deployed app it's
guarding is not a gate.

So the eval splits in two:

**`npm run eval:record`** — the expensive path. Hits real models, writes every case's full
`TurnResult` (retrieval scores, generated text, judge verdict, timings) to
`eval/fixtures/<sha>.jsonl`, and commits it. Run deliberately, a few times a day, by a human.

**`npm run eval:replay`** — free and deterministic. Reads committed fixtures, recomputes every
metric — refusal rate, false-refusal rate, hit@k, MRR, percentiles, gate attribution — and
asserts them against committed floors. **Zero neurons, zero credentials, runs on every PR
including forks.**

Two properties fall out of this that a paid plan would have let me miss:

- **The τ sweep becomes free.** Retrieval scores are recorded per case, so sweeping the threshold
  is arithmetic over stored numbers — no re-querying, no re-generating. The tradeoff table can be
  regenerated at any τ, instantly, in CI.
- **The metric code gets tested independently of the models.** A fixture with known-correct
  values is a unit test for the scoring math. Bugs in MRR or p95 stop being invisible.

The honest README framing: *the free-tier constraint pushed me into record/replay, and it turned
out to be the right architecture regardless.* That's a better story than an unconstrained build,
and it's true.

### Decision 8 — Raw `DurableObject`, not the Agents SDK

Decision 1 rejected `AIChatAgent` but kept the SDK's plain `Agent` base class. Building the
skeleton made it clear that was half a decision.

What the Agents SDK adds over a raw Durable Object is `routeAgentRequest`, client state sync via
`setState`/`onStateChanged`, `this.schedule`, and WebSocket lifecycle helpers. **This design uses
none of them** — it defines its own HTTP + SSE protocol (Decision 1), keeps conversation state
server-side in SQLite rather than syncing it to clients, and has nothing to schedule. What would
remain is `this.sql` as a tagged-template wrapper over `ctx.storage.sql.exec`, which is a
convenience, not an architecture.

So the SDK would be a dependency and an abstraction layer carried for a nicer SQL call. Extending
`DurableObject` from `cloudflare:workers` directly is fewer moving parts, and it satisfies the
"Durable Objects" component more plainly — the DO *is* the coordination primitive, not something
underneath a framework that is doing the coordinating.

*Revisit if:* multi-client state sync or scheduled work enters scope. Neither is planned.

### Decision 9 — Hand-written dual-era MCP, not an SDK

Added 2026-08-12, when the agent-facing surface went in.

**The protocol moved, and most available guidance describes the old one.** MCP revision
`2026-07-28` removed the `initialize` handshake, protocol-level sessions (`Mcp-Session-Id`), the
standalone GET/SSE stream, server-initiated JSON-RPC requests, and `Last-Event-ID` resumability.
A modern request instead carries its own protocol version and client capabilities in
`params._meta`, mirrored into `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers that the
server **must** validate against the body. This was read from the specification rather than
recalled, because everything a model has memorised — and most tutorials — describe the previous
shape.

That rewrite is what makes a Worker a good host. Stateless POST in, single JSON object out, no
session store, no stream to hold open.

**Dual-era, because modern-only would connect to nothing.** The specification's own compatibility
matrix says a legacy client against a modern-only server *fails*, and legacy clients have no
fall-forward mechanism. Every MCP client shipping today opens with `initialize`. So the server
selects behaviour from how the client opens: `_meta` or the protocol header ⇒ modern stateless
path; `initialize` ⇒ legacy. Both are stateless here, which is what makes supporting two eras
cheap rather than a second implementation.

**Why not an SDK.** `@modelcontextprotocol/sdk`'s server transports are Node-shaped (express,
`node:http`) and lag a draft revision. The Workers-native alternative is the `agents` package's
`McpAgent`, which contradicts Decision 8 and puts a framework at the centre of the one surface
whose correctness we most want to demonstrate. The modern path is a single POST handler; owning
the dispatch is also what makes per-call observability a byproduct rather than a bolt-on.

The conformance risk of hand-writing a protocol is real and is answered the way this repo answers
everything: 49 unit tests over the pure `(headers, body)` logic, running free on every PR, plus a
21-check live smoke test. The rejection paths — header mismatch, unsupported version, wrong scope,
unknown method — are the ones a well-behaved client never exercises and the ones the specification
writes as MUSTs.

**The scope boundary is cost, not secrecy.** Every document reachable through these tools is
public Cloudflare Registrar documentation and every number is already in the README; there is
nothing to withhold. What is scarce is the 10,000 neurons/day the live page also draws on. So the
privileged scope holds exactly the tools that spend — currently one — and the rate limit counts
rows in the published `mcp_calls` table rather than keeping a private counter, so the limit can be
audited rather than trusted. This is the same rationale that guards `/api/admin/ingest`, made
explicit.

*Revisit if:* a client needs streamed tool output (`subscriptions/listen`, MRTR input requests), or
legacy-era clients disappear and the handshake path can be deleted.

---

## 5b. ✅ Measured 2026-08-07 — τ is not the artifact. The sentinel gate is.

First full recording: 28 cases, 2,531 neurons, τ = 0.62.

| bucket | n | refusal | false-refusal | faithfulness | hit@6 | MRR |
|---|---|---|---|---|---|---|
| in_corpus_factual | 12 | — | **0.0%** | **1.000** | 1.000 | 0.861 |
| out_of_corpus | 8 | **100.0%** | — | — | — | — |
| ambiguous | 5 | — | — | 0.875 | — | — |
| adversarial | 3 | — | 0.0% | 1.000 | 0.667 | 0.444 |

### The threshold sweep says τ does nothing for correctness

| τ | out-of-corpus refused | in-corpus wrongly refused |
|---|---|---|
| 0.45 – 0.65 | 100% | 0% |
| 0.70 | 100% | 8.3% |
| 0.80 | 100% | 25.0% |
| 0.85 | 100% | 33.3% |

Refusal is **100% at every threshold tested**, and raising τ only ever adds false refusals. The
design predicted a tradeoff curve to tune along; there isn't one.

**Why: the score distributions overlap.**

```
in-corpus     0.683 ──────────────────────── 0.886
out-of-corpus 0.544 ─────────────── 0.757
                          ^^^^^^^^^^^^^^ overlap
```

The *highest*-scoring out-of-corpus question (0.757 — "what is Cloudflare's refund policy for
enterprise contracts") outranks the *lowest*-scoring in-corpus one (0.683 — "what is an
authorization code"). **No threshold separates them.** Similarity alone cannot do this job, and
that is now measured rather than asserted.

### Gate attribution — where the refusals actually come from

At τ = 0.62, of eight out-of-corpus questions:

- **gate one (similarity) catches 2** — `oc-01`, `oc-03`
- **gate two (sentinel) catches 6** — `oc-02`, `oc-04`, `oc-05`, `oc-06`, `oc-07`, `oc-08`

A similarity-only design would have let **six of eight** through to generation. Decision 4's
premise — that retrieval can return topically-close passages which do not answer the question —
is exactly what happened, and it is the common case rather than the edge case.

### What τ is actually for

Not correctness — **cost and latency**. Gate one refuses for **0.09 neurons and ~477 ms**; gate
two costs a full generation, roughly **100 neurons and ~4.5 s**. So τ should be set as high as
possible *without* causing false refusals, which this sweep puts at **≤ 0.65**. Keeping τ = 0.62
buys the cheap refusal on the clearly-unrelated questions while leaving correctness to gate two.

**Corrections to earlier claims in this document:**

- §6 called the τ tradeoff table "the single most convincing artifact in the repo." It is not.
  The gate-attribution result is, because it shows a design decision earning its place. The
  sweep's value turned out to be *negative* evidence — proving the simpler design would have
  failed.
- Decision 2 justified building retrieval by hand partly because "the threshold is the artifact."
  The better justification is the one that survived measurement: owning the pipeline is what made
  gate two possible at all, and a managed retrieval service would have had no place to put it.

### Other findings

- **The judge is the latency bottleneck** — p95 6,628 ms against generation's 2,355 ms. It runs
  after the answer has fully streamed, so it never delays the user's read, but it dominates the
  headless eval.
- **Adversarial retrieval is weakest** — hit@6 0.667, MRR 0.444 against 1.000/0.861 for
  straightforward in-corpus questions. False premises pull the query embedding away from the
  passage that refutes them. The model still corrected all three, so generation compensated for
  retrieval; worth noting as the place a larger corpus would hurt first.
- **The judge failed twice more, and again visibly.** Two in-corpus answers scored 0 in the first
  recording — both were unparseable judge output, not unfaithful answers. Same root cause as
  before: gpt-oss spends its budget reasoning and returns `chat.completion` with empty content.
  Raising `max_tokens` to 1500 fixed both. Three separate encounters with this one model's
  behaviour is a fair argument for preferring a non-reasoning judge.

---

## 6. The evaluation system

### Eval set — `eval/eval-set.jsonl`, 25–30 cases, committed

| Bucket | ~Count | Purpose |
|---|---|---|
| `in_corpus_factual` | 12 | Precise answers present in the corpus (grace period lengths, EPP code meanings). Graded on faithfulness + non-refusal |
| `out_of_corpus` | 8 | Plausible-sounding but unanswerable from this corpus. Graded on refusal |
| `ambiguous` | 5 | Under-specified questions ("how long is the lock?"). Graded on whether it asks for clarification rather than picking a lock type at random |
| `adversarial` | 3 | False premises ("since ICANN removed the 60-day transfer lock in 2024, …"). Graded on whether it corrects the premise instead of accepting it |

Each case: `{ id, bucket, question, expectedRefusal, mustCiteDocIds?, mustContain?, notes }`.

### Metrics

| Metric | How | Reported in |
|---|---|---|
| Refusal rate (out-of-corpus) | % of `out_of_corpus` refused | panel + CLI + README |
| **False-refusal rate (in-corpus)** | % of `in_corpus_factual` wrongly refused | panel + CLI + README |
| Faithfulness | Judge model scores answer-vs-retrieved-context, 0–1 | panel (per turn) + CLI (mean) |
| Retrieval hit rate | Did `mustCiteDocIds` appear in topK? | CLI |
| Retrieval MRR | Rank of first correct doc | CLI |
| Latency p50/p95 by stage | embed / retrieve / generate / judge | panel (per turn) + CLI |
| Gate attribution | Which gate fired on each refusal | CLI |

Retrieval hit rate and MRR aren't strictly required. They're cheap once `mustCiteDocIds` exists,
and they separate "retrieval failed" from "generation failed" — without them, a bad faithfulness
number is unattributable.

### CLI output shape

```
$ npm run eval

  bucket                n    refuse%   false-refuse%   faithfulness   hit@6   MRR
  in_corpus_factual    12          -            8.3%          0.912   0.917  0.784
  out_of_corpus         8     100.0%               -              -       -      -
  ambiguous             5      40.0%               -          0.880       -      -
  adversarial           3      66.7%               -          0.845       -      -

  latency ms      p50     p95
  embed            41      78
  retrieve         55     121
  generate       1840    3110
  judge           610    1020

  τ = 0.62   ·   run 2026-08-08T14:22Z   ·   sha a1b2c3d   ·   30/30 cases
```

---

## 7. Data model

**DO SQLite** (per session — live conversation):

```sql
messages(id, role, content, created_at)
turn_traces(id, message_id, question, refused, refusal_reason,
            retrieval_json, timings_json, judge_json, created_at)
```

**D1** (global — eval history across deploys):

```sql
eval_runs(id, started_at, git_sha, tau, generator_model, judge_model,
          n_cases, refusal_rate, false_refusal_rate, mean_faithfulness,
          hit_rate, mrr, p50_total_ms, p95_total_ms)
eval_cases(id, run_id, case_id, bucket, refused, expected_refusal,
           faithfulness, hit, rank, timings_json)
```

Clean split: DO = "what happened in this conversation," D1 = "how has quality moved across
runs." D1 also means the README's numbers come from a query, not a hand-copied paste.

---

## 8. Repo layout

```
glassbox/
├── README.md                  # component mapping, architecture, REAL numbers, limitations
├── wrangler.jsonc             # AI, Vectorize, D1, DO bindings; assets block
├── corpus/
│   ├── NOTICE.md              # provenance + licensing for every source
│   └── *.md                   # ~20 short docs, front-matter: id, title, source_url
├── eval/
│   ├── eval-set.jsonl         # 25–30 committed cases
│   ├── fixtures/<sha>.jsonl   # recorded TurnResults — the replay corpus (Decision 7)
│   ├── floors.json            # committed metric floors the CI gate asserts against
│   └── results/latest.json    # committed snapshot backing the README numbers
├── scripts/
│   ├── ingest.ts              # corpus → chunk → embed → Vectorize upsert
│   ├── eval-record.ts         # live run against deployed Worker → fixtures + D1  [costs neurons]
│   ├── eval-replay.ts         # fixtures → metrics + τ sweep + floor assertions    [free]
│   └── export-transcript.ts   # .jsonl session logs → PROMPT_HISTORY.md
├── src/
│   ├── index.ts               # Worker entry: assets + routeAgentRequest
│   ├── agent/
│   │   ├── ChatAgent.ts       # the Durable Object
│   │   ├── retrieve.ts        # embed + Vectorize query + τ gate
│   │   ├── generate.ts        # prompt construction + Llama 3.3 call
│   │   └── judge.ts           # faithfulness scoring
│   ├── shared/types.ts        # TurnResult — shared by Worker, UI, eval CLI
│   └── ui/                    # chat + evaluation panel
├── test/                      # deterministic unit tests, no network
├── docs/
│   ├── ASSIGNMENT_SPEC.md
│   └── DESIGN.md              # this file
└── .github/workflows/ci.yml
```

`src/shared/types.ts` being imported by all three consumers is deliberate — the envelope can't
drift between UI and eval.

---

## 9. CI design

The obvious approach — "run the eval suite on every PR" — fails twice over: it needs credentials
fork PRs don't have, and at ~3,700 neurons per run it would burn the daily free allocation and
take the live demo down with it (§2b). Decision 7 resolves both.

**Tier 1 — every PR, no secrets, no neurons, ~30s**
`tsc --noEmit`, lint, unit tests (chunking boundaries, τ gate logic, MRR/percentile math,
eval-set schema validation), and **`eval:replay` over committed fixtures** — full metrics
recomputed and asserted against committed floors. This is the actual regression gate: if a
prompt change or a retrieval tweak drops out-of-corpus refusal below floor, **the build fails**,
on every PR, for free. Results table posted to the PR summary.

**Tier 2 — live eval, manual + nightly, credential-gated**
`workflow_dispatch` and a nightly schedule on `main` — deliberately *not* every push. Runs
`eval:record` against the deployed Worker, writes to D1, and opens a PR if the fixtures moved.
Skipped with a neutral status where `CF_API_TOKEN` is unavailable.

The regression gate living in Tier 1 rather than Tier 2 is the point. A gate that only runs when
credentials happen to be present, and that can exhaust the budget of the service it protects,
isn't a gate — it's a report. This one blocks merges, on every PR, at zero cost.

**Credentials — nothing gets pasted anywhere.** Local dev uses `wrangler login`, which is
browser OAuth; no token is ever handled, stored in a file, or typed into a terminal. For Tier 2,
a scoped API token (Workers Scripts / AI / Vectorize / D1 edit only) goes directly into GitHub
Actions secrets via the GitHub UI. `.dev.vars` and `.env` are gitignored from the first commit.
I never need to see either credential.

---

## 10. Prompt history

**Verified today:** Claude Code writes a live JSONL transcript per session to
`~/.claude/projects/<slugified-cwd>/<session-uuid>.jsonl`. This session is
`-home-sethz-projects/c7cffd19-211c-4b9b-b92e-0913ffa5e1fe.jsonl`. The prompt-history requirement is
satisfied — export is possible, confirmed on day 1, before writing code.

**One catch, decided now.** The slug is derived from the working directory. Sessions run from
`/home/sethz/projects/glassbox` will write to a *different* folder
(`-home-sethz-projects-glassbox/`) than this scoping session. So:

- All future sessions run from the project directory (consistent from here on)
- `scripts/export-transcript.ts` accepts **multiple** source directories and merges by timestamp,
  so this session isn't orphaned
- Output: `PROMPT_HISTORY.md` — user prompts verbatim, plus assistant actions and tool calls in
  sequence, unsanitized per §2.3

On what gets submitted: your prompts carry the judgment signal the assignment is looking for, but
they only read as judgment next to what they were directing. A list of prompts with no responses
shows someone typed things; the paired transcript shows decisions landing. Export both, cut
nothing.

---

## 11. Sequence

Mapped to the assignment's done-criteria, with an explicit scope checkpoint.

**Day 0 — account, 15 minutes, you not me**
Create the free Cloudflare account, then `wrangler login` (browser OAuth — no token to handle).
Everything after this is unblocked.

**Day 1 — end-to-end skeleton**
Provision all four bindings and confirm each one actually works on the free plan · `npm create
cloudflare` · Worker + static assets serving a plain chat box · `ChatAgent` DO with `this.sql`
history · one real Workers AI call round-tripping · **verify DO→Worker streaming pass-through**
(Decision 1's load-bearing assumption) · deploy to `workers.dev`
→ *exit test: a message streams token-by-token from the deployed URL and history survives a
refresh.*

**Day 2 — grounding and measurement (protect this day)**
Curate corpus + `NOTICE.md` · `scripts/ingest.ts` → Vectorize · retrieval + τ gate · grounded
prompt + `INSUFFICIENT_CONTEXT` sentinel · judge call · full SSE protocol · write eval set ·
`eval:record` → first fixtures · `eval:replay` + τ sweep
→ **🚦 Scope checkpoint (end of day 2):** if chat and state are not working end to end by this
point, remaining scope gets cut to whatever can be finished *and* measured honestly, rather than
carrying a half-working retrieval path into day 3. Less that works beats more that doesn't.

**Day 3 — surface and write-up**
Evaluation panel wired to the SSE events · D1 eval-run persistence · GitHub Actions both tiers ·
README with component mapping, architecture, **real measured numbers**, and honest limitations ·
export prompt history · final deploy

**Neuron discipline throughout:** ~58 answered turns/day total. Day 2 spends most of its budget
on `eval:record` runs, so manual poking at the deployed app should be deliberate. If a day's
allocation runs dry, `eval:replay` and all UI work continue to function offline — another
dividend of Decision 7.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| **Daily neuron exhaustion mid-demo** — 10k/day hard-fails, ~58 turns | Highest-likelihood failure. Neuron counter in the CLI output; `eval:record` run deliberately not automatically; Tier 1 CI spends zero. If it trips, everything except live generation still works |
| **No prior Workers/DO/Vectorize experience** | Day 1 is deliberately just the skeleton. Learning shows in the transcript, which is fine and honest |
| **DO→Worker streaming pass-through** — Decision 1 depends on it | Explicit day-1 verification, before anything is built on it. Fallback: buffer in the DO, stream from the Worker |
| **Vectorize may not emulate locally** — `wrangler dev` likely needs `--remote` | Verify day 1. If remote-only, accept it; unit tests are network-free by design already |
| **24k context window** on the fp8-fast model | Budget ~6 chunks × ~400 tokens ≈ 2.4k context + history. Enforce a token budget in `generate.ts`, truncate history before context |
| Corpus licensing | `NOTICE.md` + per-doc `source_url`; paraphrase-and-cite anything unclear |
| Judge latency on every turn | Already solved by the protocol — the judge event arrives after the answer has fully streamed, so it never delays the user's read |
| Scope creep into auth / multi-tenancy / polish | Explicitly out of scope. They stay cut, and the README says so on purpose |

---

## 13. Resolved — decision log

The four open questions from the first draft, and what they changed.

| # | Question | Resolution | What it changed |
|---|---|---|---|
| 1 | Repo name | **`glassbox`** — names the differentiator, not the domain, so it survives as a portfolio piece | Directory renamed before `git init`, while it's still free to do |
| 2 | Corpus | **Confirmed:** Cloudflare Registrar docs + ICANN domain policy. Not attempting general-purpose coverage — a narrow corpus is what makes refusal measurable | No change; §1 stands |
| 3 | Account / plan | **Free plan, and staying there.** Explicit goal: see how far the free tier goes rather than spending from the start | Largest change in this revision. Drove §2b, the judge downgrade, and Decision 7 |
| 4 | Judge sync vs async | **Async**, and generalized — the whole turn is a progressive SSE reveal, not just the judge | Reversed the no-streaming call; drove the §3 protocol rewrite and Decision 1 |

**On #3 in particular:** treating the free tier as a design constraint rather than a limitation
produced better engineering than an unconstrained build would have. Record/replay eval, a CI gate
that costs nothing and therefore runs on every PR, and a τ sweep that's pure arithmetic over
stored scores — none of those were in the first draft, and all three came from having 10,000
neurons a day instead of a credit card. That's worth a paragraph in the README.

---

## 14. Repository and workflow

Set up **before** any application code, deliberately. If the repo were initialized after the
skeleton existed, the history would open with one large unexplained commit — the exact shape
that reads as unreviewed bulk generation.

**Repo:** `seth-zapata/glassbox`, **public since 2026-08-07.**

The original plan was private-during-build, public-at-submission, on the theory that privacy
bought room to correct a mistake before it was permanently indexed. That was wrong on the
merits, for two reasons:

1. **Rulesets require Pro or a public repo** (verified: `POST /rulesets` returns 403 while
   private). Protection arriving only after the code is written protects nothing.
2. **Secret scanning with push protection is free on public repos** and needs paid Advanced
   Security on private ones. Staying private wasn't buying safety — it was forfeiting the one
   control that *mechanically blocks* a credential from being pushed, in exchange for manual
   vigilance.

Both are enabled now, and a probe push to `main` is rejected with `GH013`, citing the missing
pull request and the missing `verify` check.

| Control | State |
|---|---|
| `pull_request` (0 approvals — solo) | active |
| `required_status_checks: verify`, strict | active |
| `deletion`, `non_fast_forward` | active |
| Secret scanning + push protection | enabled |

**Commit identity:** the account's GitHub `users.noreply` address. Attributes to the GitHub
account and counts toward the contribution graph without putting a personal address in a public
repository's permanent history. Set repo-locally, not globally — the machine's global git
identity is a separate decision.

### Publishing required rebuilding the repository

The pre-publication audit found one sentence in `docs/DESIGN.md` that belonged to the private
planning document. Scrubbing it locally was easy — `filter-branch`, drop `refs/original/`,
`reflog expire`, `gc --prune=now`, verified by scanning every blob in the object store.

That was not sufficient. **GitHub retains pull-request refs permanently**, and
`refs/pull/1/head` still pointed at the pre-scrub tree. Force-pushing `main` does not touch it,
and PR refs cannot be deleted. A fetch of `refs/pull/1/head` confirmed the old content was still
served. On a public repo, anyone could do that fetch.

The account's token lacked `delete_repo`, so the fix avoided deletion entirely: rename the
contaminated repository aside (it stays private), create a fresh one, and push the scrubbed
history into a repo that has never had a pull request. Verified against a `--mirror` clone of
the *remote* rather than local state: one ref, 13 blobs, clean.

**The generalisable lesson:** rewriting git history does not unpublish anything GitHub has
already indexed under a PR ref. Audit before the first pull request, not before publication.

Two of the three original audit hits were **false positives from the audit itself** — a
credential pattern written as `[0-9a-f]{32}` without word boundaries, which matches any 32-char
window of git's own 40-character blob SHAs. The committed checker uses `\b…\b` and did not have
this bug; the throwaway script did. Worth remembering that an audit tool needs the same scrutiny
as the thing it audits.

### Prompt-history pipeline

| Command | Does |
|---|---|
| `npm run transcript` | Renders all session logs → `transcripts/PROMPT_HISTORY.md`, merging both transcript directories in timestamp order |
| `npm run transcript:check` | Fails if any private phrase or credential pattern survived |

Three bugs found while building this, worth recording because each was silent:

1. **Every tool result was being dropped.** The render loop skipped non-`assistant` entries, but
   tool results arrive as `user` entries — so 88 of them vanished. The output looked clean
   because it was nearly empty, which is the most dangerous kind of passing check.
2. **The leak checker was the leak.** The first version was a shell loop echoing each search
   phrase next to its count, which wrote every sensitive phrase into the *next* export. It now
   reports by index and never prints what it searched for.
3. **Redaction matched the wrong thing.** Private-file detection scanned tool-result *bodies* for
   a path that a file read does not necessarily echo. It now resolves `tool_use_id` → the
   originating call's target, with body scanning kept only as a fallback.

Reasoning blocks are present in the logs but carry no text — only a signature — so they render
as nothing and are skipped.

---

## 15. Open questions

None blocking. Day 0 is the free Cloudflare account plus `wrangler login`; everything after that
is build work.

Two things to decide in flight, neither of which blocks starting:

1. **Chunk size and overlap.** Starting point ~400 tokens with ~15% overlap, tuned on day 2 once
   the τ sweep shows how retrieval actually behaves on this corpus. Recorded fixtures make
   re-tuning cheap.
2. **Whether the reranker earns its place.** `@cf/baai/bge-reranker-base` is available on-platform
   and would likely improve MRR, but it adds a neuron cost to every turn. Decide on day 3 with
   measured numbers in hand — and if it's cut, "measured it, wasn't worth the budget" is a better
   README line than silence.
