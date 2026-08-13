/**
 * Constant-time shared-secret comparison.
 *
 * Extracted so the ingest endpoint and the MCP server compare credentials the same way. A
 * comparison written twice is a comparison that can be subtly wrong twice, and the failure mode
 * — an early-exit `===` leaking the secret one byte at a time — is invisible in every test that
 * only checks accept-and-reject.
 *
 * The length check is deliberately outside the constant-time loop. It leaks the expected length,
 * which is not the secret, and it is what lets the loop compare equal-length strings safely.
 */
export function secretMatches(expected: string | undefined, provided: string): boolean {
  if (!expected) return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}
