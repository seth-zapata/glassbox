/**
 * Session id validation.
 *
 * Kept free of Workers-runtime imports so it can be unit-tested directly — this decides who can
 * read whose conversation, which is not a rule to verify only end-to-end.
 *
 * Session ids namespace a Durable Object and there is no authentication in front of them, so an
 * id is effectively a bearer capability: whoever holds it can read that conversation. Two rules
 * follow. There is no fallback id — an absent session previously landed in a shared "default"
 * object that any caller could read and write, turning one client bug into a pool of other
 * people's conversations. And an id must carry enough entropy not to be guessed, so short,
 * memorable values like "test" are rejected.
 */

const SESSION_ID = /^[A-Za-z0-9_-]{24,64}$/;

export function sessionIdFrom(url: URL): string | null {
  const raw = url.searchParams.get("session")?.trim() ?? "";
  return SESSION_ID.test(raw) ? raw : null;
}
