import { DurableObject } from "cloudflare:workers";
import type { StoredMessage, TurnEvent, TurnResult, RefusalReason } from "../shared/types.ts";
import { retrieve, belowThreshold, DEFAULT_TAU, EMBEDDER, TOP_K } from "./retrieve.ts";
import {
  GENERATOR,
  MAX_TOKENS,
  buildMessages,
  declined,
  neuronsFor,
  replayableContext,
  type ChatMessage,
} from "./generate.ts";
import { judge, JUDGE } from "./judge.ts";
import { refusalMessage } from "../shared/scope.ts";

/**
 * One Durable Object per chat session: conversation state plus the turn pipeline.
 *
 * The pipeline is retrieve → gate → generate → gate → judge, and it is the single code path
 * shared by the browser UI and the headless evaluation suite. That sharing is the point — an
 * evaluation that ran its own reimplementation could drift from the thing it claims to measure.
 *
 * Raw DurableObject rather than the Agents SDK: of what that SDK adds — routing, client state
 * sync, scheduling, WebSocket helpers — this design uses none (see DESIGN.md Decision 8).
 */
export class ChatAgent extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id         TEXT PRIMARY KEY,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    // Durable Objects created before refusals were persisted still exist; ALTER is the
    // migration. It throws once the column is present, which is the expected steady state.
    try {
      this.ctx.storage.sql.exec("ALTER TABLE messages ADD COLUMN refusal_reason TEXT");
    } catch {
      // Column already present.
    }
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS turn_traces (
        id            TEXT PRIMARY KEY,
        question      TEXT NOT NULL,
        refused       INTEGER NOT NULL,
        refusal_reason TEXT,
        result_json   TEXT NOT NULL,
        created_at    INTEGER NOT NULL
      )
    `);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/history")) {
      return Response.json({ messages: this.history() });
    }

    if (url.pathname.endsWith("/traces")) {
      return Response.json({ traces: this.traces() });
    }

    if (url.pathname.endsWith("/chat") && request.method === "POST") {
      const { message, tau } = (await request.json()) as { message?: string; tau?: number };
      if (!message?.trim()) {
        return Response.json({ error: "message is required" }, { status: 400 });
      }
      return this.streamTurn(message.trim(), typeof tau === "number" ? tau : DEFAULT_TAU);
    }

    return new Response("Not found", { status: 404 });
  }

  private history(): StoredMessage[] {
    return this.ctx.storage.sql
      .exec<{
        id: string;
        role: string;
        content: string;
        created_at: number;
        refusal_reason: string | null;
      }>(
        "SELECT id, role, content, created_at, refusal_reason FROM messages ORDER BY created_at ASC",
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        role: r.role as StoredMessage["role"],
        content: r.content,
        createdAt: r.created_at,
        refusalReason: (r.refusal_reason as RefusalReason | null) ?? null,
      }));
  }

  private traces(): unknown[] {
    return this.ctx.storage.sql
      .exec<{ result_json: string }>(
        "SELECT result_json FROM turn_traces ORDER BY created_at DESC LIMIT 20",
      )
      .toArray()
      .map((r) => JSON.parse(r.result_json) as unknown);
  }

  private save(
    role: StoredMessage["role"],
    content: string,
    refusalReason: RefusalReason | null = null,
  ): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (id, role, content, created_at, refusal_reason) VALUES (?, ?, ?, ?, ?)",
      crypto.randomUUID(),
      role,
      content,
      Date.now(),
      refusalReason,
    );
  }

  private saveTrace(question: string, result: TurnResult): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO turn_traces (id, question, refused, refusal_reason, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      crypto.randomUUID(),
      question,
      result.refused ? 1 : 0,
      result.refusalReason,
      JSON.stringify(result),
      Date.now(),
    );
  }

  private streamTurn(question: string, tau: number): Response {
    const started = Date.now();
    const priorTurns: ChatMessage[] = replayableContext(this.history());

    const encoder = new TextEncoder();
    const self = this;

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: TurnEvent): void => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };

        const finish = (result: TurnResult, assistantText: string | null): void => {
          self.save("user", question);
          if (assistantText !== null) {
            self.save("assistant", assistantText, result.refusalReason);
          }
          self.saveTrace(question, result);
          send({ type: "done", result });
        };

        const models = { generator: GENERATOR, embedder: EMBEDDER, judge: JUDGE };

        try {
          // ── retrieve ────────────────────────────────────────────────────────────────────
          const r = await retrieve(self.env.AI, self.env.VECTORIZE, question, TOP_K);
          send({ type: "retrieval", chunks: r.chunks, retrieveMs: r.retrieveMs });

          // ── gate one: nothing similar enough, refuse before spending a token ────────────
          if (belowThreshold(r.maxScore, tau)) {
            const reason: RefusalReason = "low_similarity";
            const message = refusalMessage(reason, r.maxScore, tau);
            send({ type: "refusal", reason, maxScore: r.maxScore, tau, message });
            finish(
              {
                answer: null,
                refused: true,
                refusalReason: reason,
                retrieval: r.chunks,
                timings: {
                  embedMs: r.embedMs,
                  retrieveMs: r.retrieveMs,
                  generateMs: 0,
                  judgeMs: 0,
                  totalMs: Date.now() - started,
                },
                judge: null,
                models,
                neurons: Math.round(r.neurons * 100) / 100,
              },
              message,
            );
            return;
          }

          // ── generate ────────────────────────────────────────────────────────────────────
          const generateStarted = Date.now();
          const upstream = (await self.env.AI.run(GENERATOR, {
            messages: buildMessages(question, r.chunks, priorTurns),
            stream: true,
            max_tokens: MAX_TOKENS,
          })) as unknown as ReadableStream<Uint8Array>;

          let answer = "";
          let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
          const reader = upstream.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          // The sentinel must not be streamed to the user as if it were an answer, and it
          // arrives token by token, so emission is held until it can be ruled out.
          let sentinelPossible = true;
          let held = "";

          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === "[DONE]") continue;
              try {
                const parsed = JSON.parse(payload) as {
                  response?: string;
                  usage?: { prompt_tokens?: number; completion_tokens?: number };
                };
                if (parsed.usage) usage = parsed.usage;
                if (!parsed.response) continue;
                answer += parsed.response;

                if (sentinelPossible) {
                  held += parsed.response;
                  const upper = held.trimStart().toUpperCase();
                  if ("INSUFFICIENT_CONTEXT".startsWith(upper) && upper.length > 0) {
                    if (upper.length < "INSUFFICIENT_CONTEXT".length) continue;
                    sentinelPossible = false;
                    continue; // confirmed sentinel — never emitted as answer text
                  }
                  sentinelPossible = false;
                  send({ type: "token", delta: held });
                  held = "";
                  continue;
                }
                send({ type: "token", delta: parsed.response });
              } catch {
                // Partial JSON at a chunk boundary; the next read completes it.
              }
            }
          }

          const generateMs = Date.now() - generateStarted;
          const genNeurons = neuronsFor(usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0);

          // ── gate two: retrieval scored fine but the passages do not answer it ───────────
          if (declined(answer)) {
            const reason: RefusalReason = "model_declined";
            const message = refusalMessage(reason, r.maxScore, tau);
            send({ type: "refusal", reason, maxScore: r.maxScore, tau, message });
            finish(
              {
                answer: null,
                refused: true,
                refusalReason: reason,
                retrieval: r.chunks,
                timings: {
                  embedMs: r.embedMs,
                  retrieveMs: r.retrieveMs,
                  generateMs,
                  judgeMs: 0,
                  totalMs: Date.now() - started,
                },
                judge: null,
                models,
                neurons: Math.round((r.neurons + genNeurons) * 100) / 100,
              },
              message,
            );
            return;
          }

          // ── judge ───────────────────────────────────────────────────────────────────────
          const j = await judge(self.env.AI, question, answer, r.chunks);
          send({ type: "judge", verdict: j.verdict });

          finish(
            {
              answer,
              refused: false,
              refusalReason: null,
              retrieval: r.chunks,
              timings: {
                embedMs: r.embedMs,
                retrieveMs: r.retrieveMs,
                generateMs,
                judgeMs: j.judgeMs,
                totalMs: Date.now() - started,
              },
              judge: j.verdict,
              models,
              neurons: Math.round((r.neurons + genNeurons + j.neurons) * 100) / 100,
            },
            answer,
          );
        } catch (error) {
          send({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  }
}
