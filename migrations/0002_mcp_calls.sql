-- Per-call observability for the MCP server.
--
-- The spec this server was built to treats observability as non-negotiable, and the reason is the
-- same one that drives the rest of this repository: an agent-facing surface that cannot report
-- what it did, how long it took, and what it cost is exactly the black box the project exists to
-- argue against. Every call lands here, including the ones that were rejected — a refusal to
-- serve is a measurement too, and the rejected calls are the ones that tell you whether the
-- authorization boundary is doing anything.
--
-- This table is also load-bearing rather than decorative: the per-token rate limit on the
-- privileged scope is a COUNT over it. That is deliberate. A limiter with its own private
-- counter is a second source of truth that nobody can audit; a limiter that counts the same rows
-- the history endpoint publishes can be checked by anyone reading the history.

CREATE TABLE IF NOT EXISTS mcp_calls (
  id          TEXT PRIMARY KEY,
  called_at   INTEGER NOT NULL,
  -- JSON-RPC method (tools/call, tools/list, server/discover, initialize).
  method      TEXT NOT NULL,
  -- Tool name for tools/call; NULL for protocol-level methods.
  tool        TEXT,
  -- 'modern' (per-request metadata, 2026-07-28+) or 'legacy' (initialize handshake).
  era         TEXT NOT NULL,
  -- 'read' | 'full'; NULL when the call never authenticated.
  scope       TEXT,
  -- ok | tool_error | protocol_error | unauthorized | forbidden | rate_limited | budget_exhausted
  outcome     TEXT NOT NULL,
  -- JSON-RPC error code when the call failed, so a failure class is queryable without parsing text.
  error_code  INTEGER,
  duration_ms INTEGER NOT NULL,
  -- Estimated from token counts, as everywhere else in this project. Zero for the free tools.
  neurons     REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_mcp_calls_time ON mcp_calls(called_at DESC);

-- Serves the rate-limit COUNT, which filters on scope + tool over a trailing window.
CREATE INDEX IF NOT EXISTS idx_mcp_calls_rate ON mcp_calls(scope, tool, called_at DESC);
