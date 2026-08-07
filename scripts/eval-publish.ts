/**
 * Publish the recorded evaluation run to D1.
 *
 * Reads committed fixtures and writes the run summary plus per-case rows. Costs **no neurons** —
 * it re-derives everything from what `eval:record` already captured. Splitting publish from
 * record means the history can be rebuilt, corrected, or re-pointed at a different database
 * without paying for another recording.
 *
 * Run:  npm run eval:publish
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  bucketMetrics,
  latencies,
  rankOfExpectedDoc,
  totalNeurons,
  type RecordedCase,
} from "../src/shared/metrics.ts";
import { DEFAULT_TAU } from "../src/agent/retrieve.ts";

const WORKER = process.env.WORKER_URL ?? "https://glassbox.glassbox.workers.dev";

function tokenFromDevVars(): string | undefined {
  const path = join(process.cwd(), ".dev.vars");
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*INGEST_TOKEN\s*=\s*(.+)\s*$/);
    if (m?.[1]) return m[1].replace(/^["']|["']$/g, "").trim();
  }
  return undefined;
}

async function main(): Promise<void> {
  const token = process.env.INGEST_TOKEN ?? tokenFromDevVars();
  if (!token) {
    console.error("INGEST_TOKEN is not set (env or .dev.vars).");
    process.exit(1);
  }

  const fixturePath = join(process.cwd(), "eval", "fixtures", "latest.json");
  if (!existsSync(fixturePath)) {
    console.error(`No fixtures at ${fixturePath}. Run \`npm run eval:record\` first.`);
    process.exit(1);
  }

  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    gitSha: string;
    records: RecordedCase[];
  };
  const records = fixture.records;

  const ic = bucketMetrics(records, "in_corpus_factual", DEFAULT_TAU);
  const oc = bucketMetrics(records, "out_of_corpus", DEFAULT_TAU);
  const total = latencies(records).find((l) => l.stage === "total");

  const payload = {
    recordedAt: Date.now(),
    summary: {
      gitSha: fixture.gitSha,
      tau: DEFAULT_TAU,
      generatorModel: records[0]?.result.models.generator ?? "",
      judgeModel: records[0]?.result.models.judge ?? "",
      nCases: records.length,
      refusalRate: oc.refusalRate ?? 0,
      falseRefusalRate: ic.falseRefusalRate ?? 0,
      meanFaithfulness: ic.meanFaithfulness ?? 0,
      hitRate: ic.hitRate ?? 0,
      mrr: ic.mrr ?? 0,
      p50TotalMs: total?.p50 ?? 0,
      p95TotalMs: total?.p95 ?? 0,
      neurons: totalNeurons(records),
    },
    cases: records.map((r) => ({
      caseId: r.case.id,
      bucket: r.case.bucket,
      refused: r.result.refused,
      refusalReason: r.result.refusalReason,
      maxScore: r.result.retrieval[0]?.score ?? 0,
      faithfulness: r.result.judge?.score ?? null,
      rankOfExpected: rankOfExpectedDoc(r),
      totalMs: r.result.timings.totalMs,
    })),
  };

  const res = await fetch(`${WORKER}/api/admin/eval-run`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ingest-token": token },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error(`  failed: HTTP ${res.status} ${await res.text()}`);
    process.exit(1);
  }

  const written = (await res.json()) as { runId: string; cases: number };
  console.log(`  published run ${written.runId} — ${written.cases} cases (sha ${fixture.gitSha})`);
  console.log(`  history: ${WORKER}/api/eval/history`);
}

await main();
