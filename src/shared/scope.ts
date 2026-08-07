/**
 * What this agent is for, and how it says no.
 *
 * A refusal that only states a threshold was not met tells the reader nothing actionable. It
 * reads as a malfunction rather than a boundary — particularly for questions that are adjacent
 * to the corpus, like a different Cloudflare product, where "I can't answer that" is surprising
 * without knowing where the edge is. Naming the scope turns a dead end into a redirection.
 *
 * The message is built server-side and sent on the wire so the live stream, the persisted
 * conversation, and the restored view cannot drift from one another.
 */

import type { RefusalReason } from "./types.ts";

export const CORPUS_SCOPE =
  "This agent only answers from Cloudflare Registrar documentation — registering, transferring " +
  "and renewing domains, contact and WHOIS settings, DNSSEC, and TLD-specific rules.";

export function refusalMessage(
  reason: RefusalReason,
  maxScore: number,
  tau: number,
): string {
  if (reason === "low_similarity") {
    return (
      `Refused — nothing in the corpus is close enough to this question. ` +
      `${CORPUS_SCOPE}\n\n` +
      `Closest match scored ${maxScore.toFixed(3)} against a gate of ${tau}, so no answer was generated.`
    );
  }
  return (
    `Refused — passages were retrieved, but none of them answer this question. ` +
    `${CORPUS_SCOPE}\n\n` +
    `The evidence below is what was retrieved; the model was asked to answer only from it, and declined.`
  );
}
