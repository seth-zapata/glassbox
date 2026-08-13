// Secrets are set with `wrangler secret put` and are not declared in wrangler.jsonc, so
// `wrangler types` cannot generate them. Declared here by interface merging rather than via a
// local .dev.vars file, so the type is identical in CI, where no such file exists.
//
// No imports or exports in this file — that keeps it a global script, which is what makes the
// merge with the generated `interface Env` work.

interface Env {
  /** Shared secret guarding /api/admin/ingest. Set: npx wrangler secret put INGEST_TOKEN */
  INGEST_TOKEN?: string;
  /** Cloudflare API token with Account Analytics:Read, for reading real neuron usage. */
  CF_ANALYTICS_TOKEN?: string;
  /** Account tag the analytics query filters on. */
  CF_ACCOUNT_TAG?: string;
  /** MCP bearer token granting the read scope — the tools that spend nothing. */
  MCP_TOKEN_READ?: string;
  /** MCP bearer token granting the full scope, including the tool that spends neurons. */
  MCP_TOKEN_FULL?: string;
}
