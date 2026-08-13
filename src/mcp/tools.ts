/**
 * The tool surface.
 *
 * The organising idea is that the *evidence* is the product. A question-answering endpoint that
 * returns prose is a thing an agent must take on trust; these tools return the retrieved passages
 * with their similarity scores, the judge's verdict on whether the answer was supported, the
 * per-stage latency, and what it cost. An agent calling `glassbox_ask` can see the same evidence
 * panel a human sees in the browser, which is the only reason exposing this over MCP is
 * interesting at all.
 *
 * Four of the five tools spend nothing, and that is a design position rather than an accident:
 * the free tools are the ones that let an agent investigate the evaluation history, and they are
 * exactly the ones a reviewer can hammer without taking the live demo down.
 */

import type { EvalCase } from "../shared/metrics.ts";
import type { TurnResult } from "../shared/types.ts";
import { retrieve, belowThreshold, DEFAULT_TAU, TOP_K } from "../agent/retrieve.ts";
import { readBudget } from "../agent/budget.ts";
import type { Scope } from "./auth.ts";

/** A tool failed in a way the caller should see: bad arguments, missing data, upstream refusal. */
export class ToolError extends Error {}

export interface ToolOutcome {
  data: unknown;
  /** Attributed to this call, for the observability row. Estimated from token counts. */
  neurons: number;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  scope: Scope;
  handler: (args: Record<string, unknown>, env: Env) => Promise<ToolOutcome>;
}

// ── argument helpers ──────────────────────────────────────────────────────────────────────────

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolError(`'${key}' is required and must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ToolError(`'${key}' must be a string`);
  return value;
}

function optionalInt(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ToolError(`'${key}' must be an integer`);
  }
  if (value < min || value > max) {
    throw new ToolError(`'${key}' must be between ${min} and ${max}`);
  }
  return value;
}

// ── the committed evaluation set ──────────────────────────────────────────────────────────────

export function parseEvalSet(source: string): EvalCase[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as EvalCase);
}

/**
 * The committed set, loaded once on first use.
 *
 * Imported dynamically rather than statically for a reason worth stating: `eval/eval-set.jsonl`
 * is a bundler text module, which the Node test runner cannot resolve. A static import at the top
 * of this file would make the whole module — including every tool schema and the scope filter —
 * unimportable from the unit tests, so the parts most worth testing for free would be the parts
 * that could not be tested at all. Deferring the import keeps the tests able to load this module
 * and only touches the file when the tool actually runs.
 */
let evalCasesCache: EvalCase[] | null = null;

async function evalCases(): Promise<EvalCase[]> {
  if (evalCasesCache === null) {
    const module = await import("../../eval/eval-set.jsonl");
    evalCasesCache = parseEvalSet(module.default);
  }
  return evalCasesCache;
}

// ── D1 row shapes ─────────────────────────────────────────────────────────────────────────────

interface RunRow {
  id: string;
  recorded_at: number;
  git_sha: string;
  tau: number;
  n_cases: number;
  refusal_rate: number;
  false_refusal_rate: number;
  mean_faithfulness: number;
  hit_rate: number;
  mrr: number;
  p50_total_ms: number;
  p95_total_ms: number;
  neurons: number;
}

interface CaseRow {
  run_id: string;
  case_id: string;
  bucket: string;
  refused: number;
  refusal_reason: string | null;
  max_score: number;
  faithfulness: number | null;
  rank_of_expected: number;
  total_ms: number;
}

const RUN_COLUMNS = `id, recorded_at, git_sha, tau, n_cases, refusal_rate, false_refusal_rate,
  mean_faithfulness, hit_rate, mrr, p50_total_ms, p95_total_ms, neurons`;

/** Metrics compared run-to-run, and whether a rise is an improvement. */
const COMPARED_METRICS = [
  { key: "refusal_rate", label: "refusalRate", higherIsBetter: true },
  { key: "false_refusal_rate", label: "falseRefusalRate", higherIsBetter: false },
  { key: "mean_faithfulness", label: "meanFaithfulness", higherIsBetter: true },
  { key: "hit_rate", label: "hitRate", higherIsBetter: true },
  { key: "mrr", label: "mrr", higherIsBetter: true },
  { key: "p50_total_ms", label: "p50TotalMs", higherIsBetter: false },
  { key: "p95_total_ms", label: "p95TotalMs", higherIsBetter: false },
  { key: "neurons", label: "neurons", higherIsBetter: false },
] as const;

function runSummary(row: RunRow) {
  return {
    id: row.id,
    recordedAt: new Date(row.recorded_at).toISOString(),
    gitSha: row.git_sha,
    tau: row.tau,
    nCases: row.n_cases,
    refusalRate: row.refusal_rate,
    falseRefusalRate: row.false_refusal_rate,
    meanFaithfulness: row.mean_faithfulness,
    hitRate: row.hit_rate,
    mrr: row.mrr,
    p50TotalMs: row.p50_total_ms,
    p95TotalMs: row.p95_total_ms,
    neurons: row.neurons,
  };
}

// ── tools ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Retrieval without generation.
 *
 * This is the cheapest way to see the thing the project's central result is about: the similarity
 * score distributions of in-corpus and out-of-corpus questions *overlap*, so no threshold
 * separates them. An agent can demonstrate that here for roughly 0.09 neurons a call — about
 * 110,000 calls to exhaust a day — which is why it sits in the read scope despite touching a
 * model at all.
 */
const retrieveTool: ToolDefinition = {
  name: "glassbox_retrieve",
  title: "Retrieve evidence (no generation)",
  description:
    "Search the Cloudflare Registrar documentation corpus and return the matching passages with " +
    "their cosine similarity scores, without generating an answer. Use this to inspect what the " +
    "agent would ground an answer on, or to compare how similar in-corpus and out-of-corpus " +
    "questions score. Reports whether the top score clears the similarity refusal gate. Costs " +
    "about 0.09 neurons per call (embedding only) and makes no generation call.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question to embed and search with.",
      },
      topK: {
        type: "integer",
        description: `How many passages to return (1-20). Defaults to ${TOP_K}, the value the deployed agent uses.`,
      },
      tau: {
        type: "number",
        description: `Similarity threshold to report the gate decision against. Defaults to ${DEFAULT_TAU}.`,
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
  scope: "read",
  async handler(args, env) {
    const question = requireString(args, "question");
    const topK = optionalInt(args, "topK", 1, 20) ?? TOP_K;
    const rawTau = args.tau;
    if (rawTau !== undefined && rawTau !== null && typeof rawTau !== "number") {
      throw new ToolError("'tau' must be a number");
    }
    const tau = typeof rawTau === "number" ? rawTau : DEFAULT_TAU;

    const result = await retrieve(env.AI, env.VECTORIZE, question, topK);
    const refusedByGate = belowThreshold(result.maxScore, tau);

    return {
      neurons: result.neurons,
      data: {
        question,
        tau,
        maxScore: result.maxScore,
        wouldRefuseOnSimilarity: refusedByGate,
        gateNote: refusedByGate
          ? "The top passage scores below tau, so the deployed agent would refuse here without calling the generator."
          : "The top passage clears tau, so the deployed agent would proceed to generation — where a second gate can still refuse.",
        chunks: result.chunks.map((c) => ({
          chunkId: c.chunkId,
          docTitle: c.docTitle,
          sourceUrl: c.sourceUrl,
          score: c.score,
          text: c.text,
        })),
        timings: { embedMs: result.embedMs, retrieveMs: result.retrieveMs },
        neurons: result.neurons,
      },
    };
  },
};

/**
 * The committed evaluation set.
 *
 * Read from the same `eval/eval-set.jsonl` the harness measures against, bundled as text, so the
 * agent-facing list cannot drift from the set the published numbers came from.
 */
const listEvalCasesTool: ToolDefinition = {
  name: "glassbox_list_eval_cases",
  title: "List evaluation cases",
  description:
    "Enumerate the committed evaluation set with each case's bucket, question, expected refusal, " +
    "and the documents or strings it must cite or contain. Buckets are in_corpus_factual, " +
    "out_of_corpus, ambiguous, and adversarial. Free — reads a committed file, calls no model.",
  inputSchema: {
    type: "object",
    properties: {
      bucket: {
        type: "string",
        enum: ["in_corpus_factual", "out_of_corpus", "ambiguous", "adversarial"],
        description: "Return only cases in this bucket. Omit for all cases.",
      },
    },
    additionalProperties: false,
  },
  scope: "read",
  async handler(args) {
    const bucket = optionalString(args, "bucket");
    const all = await evalCases();
    const cases = bucket ? all.filter((c) => c.bucket === bucket) : all;

    const byBucket: Record<string, number> = {};
    for (const c of all) byBucket[c.bucket] = (byBucket[c.bucket] ?? 0) + 1;

    return {
      neurons: 0,
      data: { total: all.length, returned: cases.length, byBucket, cases },
    };
  },
};

/**
 * Diff two recorded evaluation runs.
 *
 * The interesting half is per-case, not aggregate. D1 stores a row per case per run — refusal,
 * reason, top score, faithfulness, rank of the expected document, latency — which means this can
 * answer "which specific cases changed" rather than only "did the mean move". Those per-case rows
 * are written by every recording but were never read back before this tool existed.
 */
const compareRunsTool: ToolDefinition = {
  name: "glassbox_compare_runs",
  title: "Compare two evaluation runs",
  description:
    "Diff two recorded evaluation runs: aggregate metric deltas plus the specific cases whose " +
    "refusal, refusal reason, faithfulness, or retrieval rank changed between them. Defaults to " +
    "the two most recent runs. Use this to find what actually moved when a metric shifted. Free " +
    "— reads evaluation history from D1, calls no model.",
  inputSchema: {
    type: "object",
    properties: {
      runA: {
        type: "string",
        description: "Baseline run id. Defaults to the second most recent run.",
      },
      runB: {
        type: "string",
        description: "Comparison run id. Defaults to the most recent run.",
      },
    },
    additionalProperties: false,
  },
  scope: "read",
  async handler(args, env) {
    const runAId = optionalString(args, "runA");
    const runBId = optionalString(args, "runB");

    const { a, b } = await resolveRuns(env, runAId, runBId);

    const { results: caseResults } = await env.DB.prepare(
      `SELECT run_id, case_id, bucket, refused, refusal_reason, max_score, faithfulness,
              rank_of_expected, total_ms
         FROM eval_cases WHERE run_id IN (?, ?)`,
    )
      .bind(a.id, b.id)
      .all<CaseRow>();

    const casesA = new Map<string, CaseRow>();
    const casesB = new Map<string, CaseRow>();
    for (const row of caseResults ?? []) {
      (row.run_id === a.id ? casesA : casesB).set(row.case_id, row);
    }

    const metricDeltas = COMPARED_METRICS.map((m) => {
      const from = a[m.key] as number;
      const to = b[m.key] as number;
      const delta = to - from;
      return {
        metric: m.label,
        from,
        to,
        delta,
        direction: delta === 0 ? "unchanged" : (delta > 0) === m.higherIsBetter ? "better" : "worse",
      };
    });

    const changedCases: unknown[] = [];
    let unchanged = 0;

    for (const [caseId, rowB] of casesB) {
      const rowA = casesA.get(caseId);
      if (!rowA) {
        changedCases.push({ caseId, bucket: rowB.bucket, change: "added", to: describeCase(rowB) });
        continue;
      }
      const changes: unknown[] = [];
      if (rowA.refused !== rowB.refused) {
        changes.push({ field: "refused", from: rowA.refused === 1, to: rowB.refused === 1 });
      }
      if (rowA.refusal_reason !== rowB.refusal_reason) {
        changes.push({ field: "refusalReason", from: rowA.refusal_reason, to: rowB.refusal_reason });
      }
      if (rowA.faithfulness !== rowB.faithfulness) {
        changes.push({ field: "faithfulness", from: rowA.faithfulness, to: rowB.faithfulness });
      }
      if (rowA.rank_of_expected !== rowB.rank_of_expected) {
        changes.push({
          field: "rankOfExpected",
          from: rowA.rank_of_expected,
          to: rowB.rank_of_expected,
        });
      }
      if (changes.length === 0) {
        unchanged++;
      } else {
        changedCases.push({ caseId, bucket: rowB.bucket, change: "modified", changes });
      }
    }

    for (const [caseId, rowA] of casesA) {
      if (!casesB.has(caseId)) {
        changedCases.push({ caseId, bucket: rowA.bucket, change: "removed", from: describeCase(rowA) });
      }
    }

    return {
      neurons: 0,
      data: {
        runA: runSummary(a),
        runB: runSummary(b),
        metricDeltas,
        changedCases,
        unchangedCases: unchanged,
        note:
          changedCases.length === 0
            ? "Every case behaved identically across both runs. Latency is not compared per case; it differs on every run by design."
            : "Per-case comparison covers refusal, refusal reason, faithfulness, and retrieval rank. Latency is excluded because it differs on every run.",
      },
    };
  },
};

/**
 * Resolve the pair of runs to diff.
 *
 * Named ids must both exist — silently substituting the most recent run for one the caller asked
 * for by id would produce a comparison that answers a question nobody asked, and label it with
 * the id they wanted.
 */
async function resolveRuns(
  env: Env,
  runAId: string | undefined,
  runBId: string | undefined,
): Promise<{ a: RunRow; b: RunRow }> {
  if (runAId && runBId) {
    const { results } = await env.DB.prepare(
      `SELECT ${RUN_COLUMNS} FROM eval_runs WHERE id IN (?, ?)`,
    )
      .bind(runAId, runBId)
      .all<RunRow>();
    const rows = results ?? [];
    const a = rows.find((r) => r.id === runAId);
    const b = rows.find((r) => r.id === runBId);
    if (!a) throw new ToolError(`no evaluation run with id '${runAId}'`);
    if (!b) throw new ToolError(`no evaluation run with id '${runBId}'`);
    return { a, b };
  }

  if (runAId || runBId) {
    throw new ToolError("supply both 'runA' and 'runB', or neither to use the two most recent runs");
  }

  const { results } = await env.DB.prepare(
    `SELECT ${RUN_COLUMNS} FROM eval_runs ORDER BY recorded_at DESC LIMIT 2`,
  ).all<RunRow>();
  const recent = results ?? [];
  const [newest, previous] = recent;
  if (!newest || !previous) {
    throw new ToolError(
      `comparison needs two recorded runs; evaluation history holds ${recent.length}. ` +
        "Runs are written by the live evaluation workflow, which runs weekly.",
    );
  }
  return { a: previous, b: newest };
}

function describeCase(row: CaseRow) {
  return {
    refused: row.refused === 1,
    refusalReason: row.refusal_reason,
    maxScore: row.max_score,
    faithfulness: row.faithfulness,
    rankOfExpected: row.rank_of_expected,
  };
}

/**
 * The live Workers AI allocation.
 *
 * Exposed to agents for the same reason the browser header carries it: the budget decides whether
 * this service answers at all, and a caller that cannot see it will keep calling into a wall. It
 * reports the enforced rolling 24-hour window, not the calendar-day counter the Cloudflare console
 * shows — the two disagree, and the reassuring one is the wrong one.
 */
const budgetTool: ToolDefinition = {
  name: "glassbox_budget",
  title: "Workers AI budget",
  description:
    "Report the live Workers AI neuron allocation: consumption over the enforced rolling 24-hour " +
    "window, remaining headroom, the per-model split, and the projected recovery time when " +
    "exhausted. Call this before spending on glassbox_ask. Free — reads Cloudflare analytics, " +
    "calls no model.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  scope: "read",
  async handler(_args, env) {
    return { neurons: 0, data: await readBudget(env) };
  },
};

/**
 * The full pipeline, evidence included.
 *
 * This drives the same Durable Object the browser drives, over the same `/chat` route, rather than
 * reimplementing the pipeline for agents. That sharing is the project's central claim — an
 * evaluation or an integration that ran its own copy could drift from the thing it reports on —
 * so the MCP surface earns nothing by breaking it.
 *
 * Each call gets a throwaway session and deletes its own conversation afterwards. A tool call is
 * not a conversation: leaving rows behind would accumulate orphaned Durable Object state that
 * nothing would ever read and nobody could reach.
 */
const askTool: ToolDefinition = {
  name: "glassbox_ask",
  title: "Ask, with evidence and a verdict",
  description:
    "Run a question through the full grounded pipeline and return the answer together with the " +
    "passages it was grounded on and their scores, a second model's verdict on whether the answer " +
    "is actually supported by those passages, per-stage latency, and the neurons spent. Refuses " +
    "rather than guessing when the corpus does not cover the question, and reports which of the " +
    "two refusal gates fired. SPENDS ROUGHLY 100 NEURONS PER CALL against a 10,000/day allocation " +
    "shared with the live demo — call glassbox_budget first, and prefer glassbox_retrieve when " +
    "the evidence is what you need.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to answer." },
      tau: {
        type: "number",
        description: `Similarity threshold for the first refusal gate. Defaults to ${DEFAULT_TAU}. Set 0 to disable the gate and force generation.`,
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
  scope: "full",
  async handler(args, env) {
    const question = requireString(args, "question");
    const rawTau = args.tau;
    if (rawTau !== undefined && rawTau !== null && typeof rawTau !== "number") {
      throw new ToolError("'tau' must be a number");
    }
    const tau = typeof rawTau === "number" ? rawTau : DEFAULT_TAU;

    // crypto.randomUUID() is 36 characters, which clears the 24-character session-id minimum the
    // Worker enforces. A shorter scheme would be rejected by the same guard that protects the
    // browser sessions.
    const stub = env.CHAT_AGENT.get(env.CHAT_AGENT.idFromName(crypto.randomUUID()));

    let result: TurnResult;
    try {
      const response = await stub.fetch("https://glassbox.internal/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: question, tau }),
      });
      if (!response.ok || !response.body) {
        throw new ToolError(`pipeline returned HTTP ${response.status}`);
      }
      result = await collectTurn(response.body);
    } finally {
      // Best effort: a failed cleanup must not turn a successful answer into a tool error.
      try {
        await stub.fetch("https://glassbox.internal/history", { method: "DELETE" });
      } catch {
        // Leaves rows in a Durable Object nobody holds the id for. Harmless, and not worth
        // failing the call over.
      }
    }

    return {
      neurons: result.neurons,
      data: {
        question,
        tau,
        answer: result.answer,
        refused: result.refused,
        refusalReason: result.refusalReason,
        evidence: result.retrieval.map((c) => ({
          chunkId: c.chunkId,
          docTitle: c.docTitle,
          sourceUrl: c.sourceUrl,
          score: c.score,
          text: c.text,
        })),
        judge: result.judge,
        timings: result.timings,
        models: result.models,
        neurons: result.neurons,
      },
    };
  },
};

/**
 * Read the Durable Object's server-sent event stream down to the terminal event.
 *
 * The pipeline streams so the browser can reveal evidence before answer text. An MCP tool call is
 * a single request/response, so the stream is consumed here and only its final envelope is
 * returned — the same envelope the evaluation harness records.
 */
async function collectTurn(body: ReadableStream<Uint8Array>): Promise<TurnResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const event = JSON.parse(line.slice(5)) as {
        type: string;
        result?: TurnResult;
        message?: string;
      };
      if (event.type === "error") {
        throw new ToolError(event.message ?? "the pipeline reported an error");
      }
      if (event.type === "done" && event.result) return event.result;
    }
  }
  throw new ToolError("the pipeline closed without returning a result");
}

// ── registry ──────────────────────────────────────────────────────────────────────────────────

export const TOOLS: ToolDefinition[] = [
  retrieveTool,
  listEvalCasesTool,
  compareRunsTool,
  budgetTool,
  askTool,
];

export function toolByName(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}

/**
 * The tool list a caller may see.
 *
 * Scope-filtered rather than annotated: a read-scoped agent is never shown a tool it would be
 * refused for calling. Advertising a capability and then rejecting its use wastes a round trip and
 * teaches the model that this server is unreliable.
 */
export function toolsForScope(scope: Scope): ToolDefinition[] {
  return TOOLS.filter((t) => scope === "full" || t.scope === "read");
}

/** The wire shape of a tool definition — the internal handler and scope are not part of it. */
export function describeTool(tool: ToolDefinition) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}
