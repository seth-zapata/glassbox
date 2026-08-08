/**
 * Record the evaluation set against the deployed Worker. THIS SPENDS NEURONS.
 *
 * Human-triggered, never wired into per-push CI. The free allocation is 10,000 neurons/day and
 * requests hard-fail once it is exhausted — a gate that can take down the service it guards is
 * not a gate. `eval:replay` recomputes every metric from what this writes, for free.
 *
 * Recording runs with tau = 0, so the similarity gate never fires and generation data exists for
 * every case. That is what makes the threshold sweep in replay sound in both directions.
 *
 * Run:  npm run eval:record
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { TurnResult } from "../src/shared/types.ts";
import type { EvalCase, RecordedCase } from "../src/shared/metrics.ts";
import { totalNeurons, bucketMetrics, latencies, rankOfExpectedDoc } from "../src/shared/metrics.ts";
import { DEFAULT_TAU } from "../src/agent/retrieve.ts";

const WORKER = process.env.WORKER_URL ?? "https://glassbox.glassbox.workers.dev";

/** .dev.vars is gitignored; reading it here keeps the secret off the command line. */
function tokenFromDevVars(): string | undefined {
  const path = join(process.cwd(), ".dev.vars");
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*INGEST_TOKEN\s*=\s*(.+)\s*$/);
    if (m?.[1]) return m[1].replace(/^["']|["']$/g, "").trim();
  }
  return undefined;
}

function loadCases(): EvalCase[] {
  const path = join(process.cwd(), "eval", "eval-set.jsonl");
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as EvalCase);
}

function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function runCase(c: EvalCase): Promise<RecordedCase> {
  // A fresh Durable Object per case, so no case inherits another's conversation. Uses a UUID
  // rather than a composed string: the id must clear the 24-character minimum, and
  // `eval-${c.id}-${Date.now()}` lands on exactly 24 for the current case ids — one shorter id
  // in the eval set would 400 every case in the nightly recording.
  const res = await fetch(`${WORKER}/api/chat?session=${crypto.randomUUID()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // tau: 0 disables gate one for recording; replay applies thresholds offline.
    body: JSON.stringify({ message: c.question, tau: 0 }),
  });
  if (!res.ok || !res.body) throw new Error(`${c.id}: HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: TurnResult | undefined;
  let sawTokens = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const evt = JSON.parse(line.slice(5)) as { type: string; result?: TurnResult; message?: string };
      if (evt.type === "token") sawTokens = true;
      if (evt.type === "error") {
        // Exhausting the daily allocation is not a quality signal, and every remaining case
        // would fail identically. Mark it so the caller can stop and report it as what it is.
        if (/\b4006\b|daily free allocation/i.test(evt.message ?? "")) {
          throw new BudgetExhausted(evt.message ?? "daily neuron allocation exhausted");
        }
        throw new Error(`${c.id}: ${evt.message}`);
      }
      if (evt.type === "done") result = evt.result;
    }
  }

  if (!result) throw new Error(`${c.id}: stream ended without a done event`);
  return { case: c, result, generated: sawTokens || result.refusalReason === "model_declined" };
}

/** Thrown when Workers AI reports the daily free allocation is gone. */
class BudgetExhausted extends Error {}

/** Distinct from 1 so callers can separate "out of budget" from "the numbers moved". */
const EXIT_BUDGET_EXHAUSTED = 3;

async function main(): Promise<void> {
  const cases = loadCases();
  console.log(`Recording ${cases.length} cases against ${WORKER}`);
  console.log("  (tau = 0 — gate one disabled so the sweep has full data)\n");

  const records: RecordedCase[] = [];
  for (const c of cases) {
    try {
      const rec = await runCase(c);
      records.push(rec);
      const o = rec.result;
      const mark = o.refused ? `refused:${o.refusalReason}` : `answered f=${o.judge?.score ?? "?"}`;
      console.log(
        `  ${c.id.padEnd(6)} ${String(o.retrieval[0]?.score.toFixed(3) ?? "-").padStart(6)}  ${mark}`,
      );
    } catch (error) {
      if (error instanceof BudgetExhausted) {
        console.error(`\n  Stopped at ${c.id}: ${error.message}`);
        console.error(
          "\n  The daily Workers AI allocation is gone, so no further case can run and the\n" +
            "  existing fixture is left untouched. This is a budget condition, not a quality\n" +
            "  regression — the allocation resets at 00:00 UTC.",
        );
        process.exit(EXIT_BUDGET_EXHAUSTED);
      }
      console.error(`  ${c.id.padEnd(6)} FAILED: ${error instanceof Error ? error.message : error}`);
    }
  }

  // Written only once every case has succeeded. An incomplete recording overwriting the
  // committed baseline would leave `eval:replay` — the gate on every pull request — measuring
  // against nothing.
  if (records.length < cases.length) {
    console.error(
      `\n  ${cases.length - records.length} of ${cases.length} case(s) failed — the existing ` +
        `fixture is left untouched rather than replaced with a partial recording.`,
    );
    process.exit(1);
  }

  const sha = gitSha();
  const dir = join(process.cwd(), "eval", "fixtures");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const payload = {
    // No timestamp: it would churn the fixture on every re-record and obscure real diffs.
    gitSha: sha,
    worker: WORKER,
    cases: records.length,
    records,
  };
  const path = join(dir, "latest.json");
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);

  console.log(`\n  wrote ${path}  (${records.length}/${cases.length} cases, sha ${sha})`);
  console.log(`  neurons spent: ${totalNeurons(records)} of 10,000/day`);
  console.log("  next: npm run eval:publish  (writes this run to D1 — costs nothing)");
}

await main();
