/**
 * Worker entry point.
 *
 * Routes /api/* to the session's Durable Object and lets everything else fall through to static
 * assets. The Durable Object's streaming Response is returned unmodified — reading or rewrapping
 * the body here would buffer it and defeat the progressive reveal.
 */

import { ingest } from "./agent/ingest.ts";
import type { CorpusDoc } from "./agent/chunk.ts";
import { sessionIdFrom } from "./shared/session.ts";
import { secretMatches } from "./shared/secret.ts";
import { readBudget } from "./agent/budget.ts";
import { writeRun, listRuns, type EvalRunSummary, type EvalCaseRow } from "./agent/evalStore.ts";
import { handleMcp } from "./mcp/handler.ts";
import { listCalls } from "./mcp/observe.ts";

export { ChatAgent } from "./agent/ChatAgent.ts";


/**
 * Ingest is guarded by a shared secret, not because the corpus is sensitive, but because it
 * spends against a hard-capped daily Workers AI allocation. An unauthenticated endpoint that
 * burns the budget would take the live demo down with it. The MCP server's privileged scope
 * exists for the same reason and shares the comparison.
 *
 * Set with: npx wrangler secret put INGEST_TOKEN
 */
function ingestAuthorized(request: Request, env: Env): boolean {
  return secretMatches(env.INGEST_TOKEN, request.headers.get("x-ingest-token") ?? "");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // The MCP endpoint. Deliberately not under /api/: it is a protocol surface with its own
    // transport rules, not another JSON route, and the specification asks for a single dedicated
    // endpoint path. Handled before the asset fallthrough, and listed in run_worker_first.
    if (url.pathname === "/mcp") {
      return handleMcp(request, env);
    }

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/api/admin/ingest" && request.method === "POST") {
      if (!ingestAuthorized(request, env)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const { docs } = (await request.json()) as { docs?: CorpusDoc[] };
      if (!Array.isArray(docs) || docs.length === 0) {
        return Response.json({ error: "docs[] is required" }, { status: 400 });
      }
      const report = await ingest(env.AI, env.VECTORIZE, docs);
      return Response.json(report);
    }

    if (url.pathname === "/api/admin/eval-run" && request.method === "POST") {
      if (!ingestAuthorized(request, env)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const body = (await request.json()) as {
        summary?: EvalRunSummary;
        cases?: EvalCaseRow[];
        recordedAt?: number;
      };
      if (!body.summary || !Array.isArray(body.cases)) {
        return Response.json({ error: "summary and cases[] are required" }, { status: 400 });
      }
      // recordedAt comes from the client: Workers have no wall clock outside a request, and the
      // recording ran on the client's clock anyway.
      const written = await writeRun(env.DB, body.summary, body.cases, body.recordedAt ?? Date.now());
      return Response.json(written);
    }

    // Public read. The allocation governs whether this app answers at all, so it is shown
    // rather than hidden — and it reports the window that is actually enforced, not the
    // calendar-day counter that reads reassuringly while every request is failing.
    if (url.pathname === "/api/budget") {
      return Response.json(await readBudget(env), {
        headers: { "cache-control": "public, max-age=30" },
      });
    }

    // Public read — the evaluation history is the point of publishing this at all.
    if (url.pathname === "/api/eval/history") {
      return Response.json({ runs: await listRuns(env.DB) });
    }

    // Public read, for the same reason: an MCP server that reports per-call latency, outcome and
    // cost only to its operator is asking to be taken on trust. The rows carry no request
    // content — method, tool, era, scope, outcome, duration, neurons — so publishing them
    // exposes how the server behaves without exposing what anyone asked it.
    if (url.pathname === "/api/mcp/history") {
      return Response.json({ calls: await listCalls(env.DB) });
    }

    const session = sessionIdFrom(url);
    if (session === null) {
      return Response.json(
        {
          error:
            "a session id of 24-64 characters ([A-Za-z0-9_-]) is required; conversations are isolated per id and there is no shared default",
        },
        { status: 400 },
      );
    }

    const id = env.CHAT_AGENT.idFromName(session);
    return env.CHAT_AGENT.get(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;
