/**
 * Verify the exported prompt history contains no private content.
 *
 * This deliberately never prints the strings it searches for. An earlier version of this check
 * was a shell loop that echoed each pattern alongside its count — which wrote every sensitive
 * phrase into the next export, so the audit became the leak. Patterns are read from the
 * gitignored redaction config and reported only by index.
 *
 * Run:  npm run transcript:check
 */

import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

const repoRoot = process.cwd();
const configPath = join(repoRoot, "scripts", "redactions.local.json");
const transcriptPath = join(repoRoot, "transcripts", "PROMPT_HISTORY.md");

if (!existsSync(transcriptPath)) {
  console.error(`No transcript at ${transcriptPath}. Run \`npm run transcript\` first.`);
  process.exit(1);
}

const transcript = readFileSync(transcriptPath, "utf8").toLowerCase();

// The phrase list is gitignored, so it does not exist in CI. Without this guard the check would
// load zero phrases, find zero matches, and report success — passing by having nothing to check,
// which is the same failure mode as a checker that silently produces no output. CI must opt in
// to the reduced check explicitly, and the reduced scope is printed in the result.
const credentialsOnly = process.argv.includes("--credentials-only");

if (!existsSync(configPath) && !credentialsOnly) {
  console.error(
    `Missing ${configPath}.\n` +
      `Private-phrase verification cannot run without it, and passing without checking would be\n` +
      `worse than failing. Copy scripts/redactions.example.json, or pass --credentials-only to\n` +
      `run just the credential patterns (which need no configuration).`,
  );
  process.exit(1);
}

const config = existsSync(configPath)
  ? (JSON.parse(readFileSync(configPath, "utf8")) as { phrases?: string[]; filePaths?: string[] })
  : { phrases: [], filePaths: [] };

/** Always-on credential checks. Named, so a failure is actionable without naming the value. */
const CREDENTIAL_CHECKS: Array<{ name: string; pattern: RegExp }> = [
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/ },
  { name: "openai-style-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "cloudflare-account-id", pattern: /\b[0-9a-f]{32}\b/ },
  { name: "private-key-block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "email-address", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
];

let failures = 0;

const phrases = credentialsOnly ? [] : (config.phrases ?? []);
phrases.forEach((phrase, i) => {
  if (transcript.includes(phrase.toLowerCase())) {
    console.error(`  ✗ private phrase #${i} still present`);
    failures++;
  }
});

const paths = config.filePaths ?? [];
paths.forEach((p, i) => {
  // The path itself appearing is fine and expected — it shows a file was read. What must not
  // appear is its content, which the phrase checks above cover.
  void p;
  void i;
});

for (const check of CREDENTIAL_CHECKS) {
  if (check.pattern.test(transcript)) {
    console.error(`  ✗ credential pattern matched: ${check.name}`);
    failures++;
  }
}

console.log(
  `Checked ${phrases.length} private phrase(s) and ${CREDENTIAL_CHECKS.length} credential pattern(s) ` +
    `against ${transcript.length.toLocaleString()} characters.`,
);
if (credentialsOnly) {
  console.log(
    "Mode: credentials-only — private-phrase verification was SKIPPED (no config available).\n" +
      "The full check runs locally before the transcript is committed.",
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED — do not commit this transcript.`);
  process.exit(1);
}

console.log("All clear.");
