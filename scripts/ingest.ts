/**
 * Push the committed corpus into Vectorize.
 *
 * Reads corpus/docs/, posts the documents to the deployed Worker's ingest endpoint, and prints
 * what happened. Chunking and embedding run inside the Worker so they use the same bindings and
 * the same code as the query path.
 *
 * Run:  INGEST_TOKEN=... npm run ingest
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseCorpusFile } from "../src/agent/chunk.ts";

const WORKER = process.env.WORKER_URL ?? "https://glassbox.glassbox.workers.dev";

/**
 * Read the token from .dev.vars when it isn't already in the environment.
 *
 * .dev.vars is gitignored. Loading it here means the secret never has to be typed on a command
 * line, where it would be captured into shell history and into this project's own committed
 * session transcript.
 */
function tokenFromDevVars(): string | undefined {
  const path = join(process.cwd(), ".dev.vars");
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*INGEST_TOKEN\s*=\s*(.+)\s*$/);
    if (m?.[1]) return m[1].replace(/^["']|["']$/g, "").trim();
  }
  return undefined;
}

const TOKEN = process.env.INGEST_TOKEN ?? tokenFromDevVars();

interface IngestReport {
  documents: number;
  chunks: number;
  upserted: number;
  embedMs: number;
  upsertMs: number;
  neurons: number;
  perDocument: Array<{ id: string; chunks: number }>;
}

async function main(): Promise<void> {
  if (!TOKEN) {
    console.error(
      "INGEST_TOKEN is not set.\n" +
        "  Set the Worker secret:  npx wrangler secret put INGEST_TOKEN\n" +
        "  Then run:               INGEST_TOKEN=<same value> npm run ingest",
    );
    process.exit(1);
  }

  const dir = join(process.cwd(), "corpus", "docs");
  const docs = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => parseCorpusFile(readFileSync(join(dir, f), "utf8"), f.replace(/\.md$/, "")));

  const chars = docs.reduce((n, d) => n + d.body.length, 0);
  console.log(`Ingesting ${docs.length} documents (${chars.toLocaleString()} chars) → ${WORKER}`);

  const res = await fetch(`${WORKER}/api/admin/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ingest-token": TOKEN },
    body: JSON.stringify({ docs }),
  });

  if (!res.ok) {
    console.error(`  failed: HTTP ${res.status} ${await res.text()}`);
    process.exit(1);
  }

  const report = (await res.json()) as IngestReport;
  console.log();
  for (const d of report.perDocument) {
    console.log(`  ${String(d.chunks).padStart(3)} chunks  ${d.id}`);
  }
  console.log();
  console.log(`  documents : ${report.documents}`);
  console.log(`  chunks    : ${report.chunks}`);
  console.log(`  upserted  : ${report.upserted}`);
  console.log(`  embed     : ${report.embedMs} ms`);
  console.log(`  upsert    : ${report.upsertMs} ms`);
  console.log(`  neurons   : ${report.neurons.toFixed(1)}  (of 10,000/day)`);
}

await main();
