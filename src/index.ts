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
import { writeRun, listRuns, type EvalRunSummary, type EvalCaseRow } from "./agent/evalStore.ts";

export { ChatAgent } from "./agent/ChatAgent.ts";


/**
 * Ingest is guarded by a shared secret, not because the corpus is sensitive, but because it
 * spends against a hard-capped daily Workers AI allocation. An unauthenticated endpoint that
 * burns the budget would take the live demo down with it.
 *
 * Set with: npx wrangler secret put INGEST_TOKEN
 */
function ingestAuthorized(request: Request, env: Env): boolean {
  const expected = env.INGEST_TOKEN;
  if (!expected) return false;
  const provided = request.headers.get("x-ingest-token") ?? "";
  if (provided.length !== expected.length) return false;
  // Constant-time compare; cheap, and avoids a timing oracle on a shared secret.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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

    // Public read — the evaluation history is the point of publishing this at all.
    if (url.pathname === "/api/eval/history") {
      return Response.json({ runs: await listRuns(env.DB) });
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
