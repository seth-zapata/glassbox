/**
 * Bearer authentication and scoping for the MCP endpoint.
 *
 * **The scope boundary here is cost, not secrecy.** Every document this server can reach is
 * public Cloudflare Registrar documentation, and every evaluation number it reports is already
 * published in the README. There is nothing to keep from anyone. What is scarce is the Workers AI
 * allocation: 10,000 neurons per rolling 24 hours, after which the deployed demo hard-fails for
 * everybody. So the privileged scope is not "the sensitive tools" — it is "the tools that spend
 * the budget the live page runs on", which is the same reason `/api/admin/ingest` is guarded.
 *
 * That distinction is worth stating plainly because it changes what the authorization is *for*:
 * it is a spend control, and it should be judged as one.
 */

import { secretMatches } from "../shared/secret.ts";

/** `read` costs approximately nothing to serve; `full` can spend the daily allocation. */
export type Scope = "read" | "full";

export interface Principal {
  scope: Scope;
}

/**
 * Resolve a bearer token to a scope.
 *
 * Both tokens are compared on every call rather than short-circuiting on the first match, so the
 * work done is independent of which token was presented. Returns null for a missing, malformed,
 * or unrecognised credential — the caller turns that into a 401.
 */
export function authenticate(request: Request, env: Env): Principal | null {
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return null;
  const token = header.slice(prefix.length);
  if (token.length === 0) return null;

  const isFull = secretMatches(env.MCP_TOKEN_FULL, token);
  const isRead = secretMatches(env.MCP_TOKEN_READ, token);

  if (isFull) return { scope: "full" };
  if (isRead) return { scope: "read" };
  return null;
}

/** `full` subsumes `read`; a read token cannot reach a tool that spends. */
export function scopeSatisfies(held: Scope, required: Scope): boolean {
  return held === "full" || required === "read";
}
