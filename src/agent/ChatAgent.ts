import { DurableObject } from "cloudflare:workers";
import type { StoredMessage, TurnEvent } from "../shared/types.ts";

/**
 * One Durable Object per chat session.
 *
 * Holds the conversation in its own embedded SQLite, and orchestrates the turn pipeline. This
 * skeleton stage proves the platform assumptions the design rests on — Workers AI responds, DO
 * SQLite persists across requests, and a streaming Response survives the hop from the Durable
 * Object out through the parent Worker without being buffered. Retrieval, refusal gating, and
 * the judge land on top of this same path.
 *
 * Deliberately a raw DurableObject rather than the Agents SDK: of what that SDK adds — request
 * routing, client state sync, scheduling, WebSocket helpers — this design uses none, having
 * already chosen an HTTP/SSE protocol it defines itself.
 */

const GENERATOR = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Published rates, per million tokens. Used to report spend against the 10,000/day free tier. */
const NEURONS_PER_M = { generatorIn: 26_668, generatorOut: 204_805 } as const;

const SYSTEM_PROMPT =
  "You are a concise assistant. Answer in at most three sentences.";

export class ChatAgent extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Runs on every construction; CREATE TABLE IF NOT EXISTS makes that idempotent.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id         TEXT PRIMARY KEY,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/history")) {
      return Response.json({ messages: this.history() });
    }

    if (url.pathname.endsWith("/chat") && request.method === "POST") {
      const { message } = (await request.json()) as { message?: string };
      if (!message?.trim()) {
        return Response.json({ error: "message is required" }, { status: 400 });
      }
      return this.streamTurn(message.trim());
    }

    return new Response("Not found", { status: 404 });
  }

  private history(): StoredMessage[] {
    return this.ctx.storage.sql
      .exec<{ id: string; role: string; content: string; created_at: number }>(
        "SELECT id, role, content, created_at FROM messages ORDER BY created_at ASC",
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        role: r.role as StoredMessage["role"],
        content: r.content,
        createdAt: r.created_at,
      }));
  }

  private save(role: StoredMessage["role"], content: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (id, role, content, created_at) VALUES (?, ?, ?, ?)",
      crypto.randomUUID(),
      role,
      content,
      Date.now(),
    );
  }

  /**
   * Streams the turn as server-sent events. The response body is produced lazily, so the first
   * byte leaves the Durable Object before the model has finished generating — which is the
   * property the streaming design depends on.
   */
  private streamTurn(message: string): Response {
    const started = Date.now();
    const priorTurns = this.history();
    this.save("user", message);

    const encoder = new TextEncoder();
    const send = (
      controller: ReadableStreamDefaultController<Uint8Array>,
      event: TurnEvent,
    ): void => {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    };

    // `self` avoids `this` rebinding inside the stream callbacks.
    const self = this;

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          // Retrieval is not wired yet; the event is emitted with an empty set so the wire
          // protocol is exercised end to end from the first deploy.
          send(controller, { type: "retrieval", chunks: [], retrieveMs: 0 });

          const messages = [
            { role: "system", content: SYSTEM_PROMPT },
            ...priorTurns.map((m) => ({ role: m.role, content: m.content })),
            { role: "user", content: message },
          ];

          const generateStarted = Date.now();
          const upstream = (await self.env.AI.run(GENERATOR, {
            messages,
            stream: true,
            max_tokens: 256,
          })) as unknown as ReadableStream<Uint8Array>;

          let answer = "";
          let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

          // Workers AI streams its own SSE. Parse it, re-emit under this protocol's event
          // names, and accumulate the full text for persistence.
          const reader = upstream.getReader();
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
              const payload = line.slice(5).trim();
              if (!payload || payload === "[DONE]") continue;
              try {
                const parsed = JSON.parse(payload) as {
                  response?: string;
                  usage?: { prompt_tokens?: number; completion_tokens?: number };
                };
                if (parsed.usage) usage = parsed.usage;
                if (parsed.response) {
                  answer += parsed.response;
                  send(controller, { type: "token", delta: parsed.response });
                }
              } catch {
                // A partial JSON frame at a chunk boundary is expected; the next read completes it.
              }
            }
          }

          const generateMs = Date.now() - generateStarted;
          self.save("assistant", answer);

          const inTok = usage?.prompt_tokens ?? 0;
          const outTok = usage?.completion_tokens ?? 0;
          const neurons =
            (inTok * NEURONS_PER_M.generatorIn + outTok * NEURONS_PER_M.generatorOut) / 1_000_000;

          send(controller, {
            type: "done",
            result: {
              answer,
              refused: false,
              refusalReason: null,
              retrieval: [],
              timings: {
                embedMs: 0,
                retrieveMs: 0,
                generateMs,
                judgeMs: 0,
                totalMs: Date.now() - started,
              },
              judge: null,
              models: { generator: GENERATOR, embedder: "", judge: "" },
              neurons: Math.round(neurons * 100) / 100,
            },
          });
        } catch (error) {
          send(controller, {
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
