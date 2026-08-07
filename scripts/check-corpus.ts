/**
 * Verify the committed corpus is intact and properly attributed.
 *
 * The corpus is redistributed under CC BY 4.0, which requires attribution. Attribution that is
 * only correct at the moment it is written tends not to stay correct, so it is checked here and
 * the check runs on every pull request. Costs nothing and needs no network.
 *
 * Run:  npm run corpus:check
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseCorpusFile, chunkDocument } from "../src/agent/chunk.ts";

const dir = join(process.cwd(), "corpus", "docs");
const notice = join(process.cwd(), "corpus", "NOTICE.md");

let failures = 0;
const fail = (msg: string): void => {
  console.error(`  ✗ ${msg}`);
  failures++;
};

if (!existsSync(notice)) fail("corpus/NOTICE.md is missing — attribution is a license condition");

const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
if (files.length === 0) fail("corpus/docs/ is empty — run `npm run corpus:fetch`");

let totalChars = 0;
let totalChunks = 0;

for (const file of files) {
  const raw = readFileSync(join(dir, file), "utf8");
  const doc = parseCorpusFile(raw, file.replace(/\.md$/, ""));

  if (!raw.startsWith("---\n")) fail(`${file}: no front-matter`);
  if (!doc.sourceUrl.startsWith("https://")) fail(`${file}: missing or invalid source_url`);
  if (!/^license:\s*CC-BY-4\.0$/m.test(raw)) fail(`${file}: missing license: CC-BY-4.0`);
  if (!/^attribution:\s*\S/m.test(raw)) fail(`${file}: missing attribution line`);
  if (doc.body.length < 200) fail(`${file}: body is only ${doc.body.length} chars`);

  // Component markup would contribute tokens without meaning, letting a chunk match on a
  // component name rather than its content.
  if (/<[A-Z][A-Za-z]*[\s/>]/.test(doc.body)) fail(`${file}: residual MDX component markup`);
  if (/^import\s/m.test(doc.body)) fail(`${file}: residual import statement`);

  totalChars += doc.body.length;
  totalChunks += chunkDocument(doc).length;
}

console.log(
  `Checked ${files.length} corpus documents — ${totalChars.toLocaleString()} chars, ` +
    `${totalChunks} chunks at the committed chunk settings.`,
);

if (failures > 0) {
  console.error(`\n${failures} corpus check(s) FAILED.`);
  process.exit(1);
}
console.log("All clear.");
