-- Record the protocol version each caller declares.
--
-- Added after MCP Inspector — the first real client pointed at this server — was rejected by an
-- era-detection bug. The server had classified the call correctly enough to log it, but not
-- precisely enough to answer the question that mattered: which revision was the client actually
-- speaking? That had to be inferred from changelogs, which is how the bug got written in the
-- first place.
--
-- Recording the declared version turns "what do real clients negotiate" into a query.

ALTER TABLE mcp_calls ADD COLUMN protocol_version TEXT;
