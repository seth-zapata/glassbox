// `eval/eval-set.jsonl` is bundled into the Worker as text (see the Text rule in wrangler.jsonc)
// so the MCP tool that enumerates evaluation cases reads the same committed file the harness
// does. Copying those 28 cases into a second source would let the agent-facing list drift away
// from the set the numbers were actually measured on, which is the one thing this project is
// least willing to allow.
declare module "*.jsonl" {
  const content: string;
  export default content;
}
