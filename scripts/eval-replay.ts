/**
 * Recompute every evaluation metric from committed fixtures and assert them against floors.
 *
 * Free, deterministic, credential-free — which is what lets it be the gate that blocks merges on
 * every pull request, forks included. The expensive half (`eval:record`) is human-triggered.
 *
 * Run:  npm run eval:replay
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  bucketMetrics,
  sweepTau,
  tauRange,
  latencies,
  totalNeurons,
  type Bucket,
  type RecordedCase,
} from "../src/shared/metrics.ts";
import { DEFAULT_TAU } from "../src/agent/retrieve.ts";

interface Floors {
  outOfCorpusRefusalRate: number;
  inCorpusFalseRefusalRateMax: number;
  meanFaithfulnessMin: number;
  retrievalHitRateMin: number;
}

const BUCKETS: Bucket[] = ["in_corpus_factual", "out_of_corpus", "ambiguous", "adversarial"];

function pct(v: number | null): string {
  return v === null ? "     -" : `${(v * 100).toFixed(1).padStart(5)}%`;
}
function num(v: number | null, digits = 3): string {
  return v === null ? "    -" : v.toFixed(digits).padStart(5);
}

function main(): void {
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
  const tau = Number(process.env.TAU ?? DEFAULT_TAU);

  console.log(`\n  glassbox evaluation — replayed from fixtures (sha ${fixture.gitSha}), tau = ${tau}\n`);

  // ── per-bucket ────────────────────────────────────────────────────────────────────────
  console.log("  bucket                 n   refuse%  false-refuse%  faithful   hit@6    MRR");
  console.log("  ─────────────────────────────────────────────────────────────────────────");
  for (const bucket of BUCKETS) {
    const m = bucketMetrics(records, bucket, tau);
    if (m.n === 0) continue;
    console.log(
      `  ${bucket.padEnd(20)} ${String(m.n).padStart(2)}   ${pct(m.refusalRate)}        ` +
        `${pct(m.falseRefusalRate)}     ${num(m.meanFaithfulness)}   ${num(m.hitRate)}  ${num(m.mrr)}`,
    );
  }

  // ── latency ───────────────────────────────────────────────────────────────────────────
  console.log("\n  latency ms      p50     p95");
  console.log("  ───────────────────────────");
  for (const l of latencies(records)) {
    console.log(`  ${l.stage.padEnd(12)} ${String(l.p50).padStart(5)}   ${String(l.p95).padStart(5)}`);
  }

  // ── tau sweep ─────────────────────────────────────────────────────────────────────────
  // The tradeoff table. Refusal rate alone is gamed by refusing everything, so it is only
  // meaningful next to the false-refusal rate it trades against.
  const sweep = sweepTau(records, tauRange(0.45, 0.85, 0.05));
  console.log("\n  tau sweep      out-of-corpus refused    in-corpus wrongly refused");
  console.log("  ──────────────────────────────────────────────────────────────────");
  let best = sweep[0];
  for (const p of sweep) {
    if (best && p.balancedScore > best.balancedScore) best = p;
    const marker = Math.abs(p.tau - tau) < 1e-9 ? " ← current" : "";
    console.log(
      `   ${p.tau.toFixed(2)}                 ${pct(p.outOfCorpusRefusalRate)}                    ` +
        `${pct(p.inCorpusFalseRefusalRate)}${marker}`,
    );
  }
  if (best) {
    console.log(`\n  best balanced tau: ${best.tau.toFixed(2)}  (refuse ${pct(best.outOfCorpusRefusalRate)}, false-refuse ${pct(best.inCorpusFalseRefusalRate)})`);
  }

  console.log(`\n  ${records.length} cases · ${totalNeurons(records)} neurons at record time`);

  // ── floors ────────────────────────────────────────────────────────────────────────────
  const floorsPath = join(process.cwd(), "eval", "floors.json");
  if (!existsSync(floorsPath)) {
    console.log("\n  no eval/floors.json — reporting only, not gating.\n");
    return;
  }
  const floors = JSON.parse(readFileSync(floorsPath, "utf8")) as Floors;

  const oc = bucketMetrics(records, "out_of_corpus", tau);
  const ic = bucketMetrics(records, "in_corpus_factual", tau);

  const checks: Array<{ name: string; actual: number; bound: number; ok: boolean }> = [
    {
      name: "out-of-corpus refusal rate ≥",
      actual: oc.refusalRate ?? 0,
      bound: floors.outOfCorpusRefusalRate,
      ok: (oc.refusalRate ?? 0) >= floors.outOfCorpusRefusalRate,
    },
    {
      name: "in-corpus false-refusal ≤",
      actual: ic.falseRefusalRate ?? 0,
      bound: floors.inCorpusFalseRefusalRateMax,
      ok: (ic.falseRefusalRate ?? 0) <= floors.inCorpusFalseRefusalRateMax,
    },
    {
      name: "in-corpus faithfulness ≥",
      actual: ic.meanFaithfulness ?? 0,
      bound: floors.meanFaithfulnessMin,
      ok: (ic.meanFaithfulness ?? 0) >= floors.meanFaithfulnessMin,
    },
    {
      name: "in-corpus retrieval hit@6 ≥",
      actual: ic.hitRate ?? 0,
      bound: floors.retrievalHitRateMin,
      ok: (ic.hitRate ?? 0) >= floors.retrievalHitRateMin,
    },
  ];

  console.log("\n  regression floors");
  console.log("  ─────────────────");
  for (const c of checks) {
    console.log(
      `  ${c.ok ? "✓" : "✗"} ${c.name.padEnd(30)} ${c.actual.toFixed(3)}  (bound ${c.bound.toFixed(3)})`,
    );
  }

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.error(`\n  ${failed.length} floor(s) breached — failing the build.\n`);
    process.exit(1);
  }
  console.log("\n  all floors held.\n");
}

main();
