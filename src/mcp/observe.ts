/**
 * Per-call observability, and the rate limiter that reads it.
 *
 * Every call is recorded — including the ones rejected before they did any work. Recording only
 * successes would make the authorization boundary invisible: "no unauthorized calls" and "no
 * record of unauthorized calls" look identical in a table that never writes them.
 *
 * The rate limiter counts these same rows rather than keeping a private counter. That is one
 * fewer piece of state, and it means the limit can be audited from the published history instead
 * of taken on trust — which is the standard the rest of this repository is held to.
 */

export type Outcome =
  | "ok"
  | "tool_error"
  | "protocol_error"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "budget_exhausted";

export interface CallRecord {
  method: string;
  tool: string | null;
  era: string;
  scope: string | null;
  outcome: Outcome;
  errorCode: number | null;
  durationMs: number;
  neurons: number;
}

export async function recordCall(db: D1Database, record: CallRecord, at: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO mcp_calls (id, called_at, method, tool, era, scope, outcome, error_code,
         duration_ms, neurons)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      at,
      record.method,
      record.tool,
      record.era,
      record.scope,
      record.outcome,
      record.errorCode,
      record.durationMs,
      record.neurons,
    )
    .run();
}

/**
 * Successful privileged calls to one tool within a trailing window.
 *
 * Only `ok` rows count. A rejected call spent nothing, so charging it against the limit would let
 * a caller lock itself out by sending malformed arguments — turning the spend control into a
 * denial-of-service against its own user.
 */
export async function successfulCallsSince(
  db: D1Database,
  tool: string,
  since: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM mcp_calls
        WHERE tool = ? AND called_at >= ? AND outcome = 'ok'`,
    )
    .bind(tool, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function listCalls(db: D1Database, limit = 100): Promise<unknown[]> {
  const { results } = await db
    .prepare(
      `SELECT id, called_at, method, tool, era, scope, outcome, error_code, duration_ms, neurons
         FROM mcp_calls ORDER BY called_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all();
  return results ?? [];
}
