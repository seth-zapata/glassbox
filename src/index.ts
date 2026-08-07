/**
 * Worker entry point.
 *
 * Routes /api/* to the session's Durable Object and lets everything else fall through to the
 * static asset store. The Durable Object's streaming Response is returned unmodified — reading
 * or rewrapping the body here would buffer it and defeat the progressive reveal.
 */

export { ChatAgent } from "./agent/ChatAgent.ts";

/** Session ids come from the client and only namespace a Durable Object, but bound the length. */
function sessionIdFrom(url: URL): string {
  const raw = url.searchParams.get("session")?.trim();
  if (!raw) return "default";
  return raw.slice(0, 64);
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

    const id = env.CHAT_AGENT.idFromName(sessionIdFrom(url));
    return env.CHAT_AGENT.get(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;
