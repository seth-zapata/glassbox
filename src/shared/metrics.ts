/**
 * Evaluation metrics.
 *
 * Pure functions over recorded results, so every number in the README can be recomputed from
 * committed fixtures with no network, no credentials, and no model spend. That is what lets the
 * regression gate run on every pull request including forks.
 */

import type { TurnResult } from "./types.ts";

export type Bucket = "in_corpus_factual" | "out_of_corpus" | "ambiguous" | "adversarial";

export interface EvalCase {
  id: string;
  bucket: Bucket;
  question: string;
  /** null where refusal is not the thing being graded (ambiguous cases). */
  expectedRefusal: boolean | null;
  mustCiteDocIds: string[] | null;
  mustContain: string[] | null;
  notes: string | null;
}

export interface RecordedCase {
  case: EvalCase;
  result: TurnResult;
  /**
   * Whether generation ran. Recording uses tau = 0 so gate one never fires, which is what makes
   * the threshold sweep sound in both directions — see sweepTau.
   */
  generated: boolean;
}

/** Decide the outcome a given tau would have produced, from data already recorded. */
export function outcomeAtTau(rec: RecordedCase, tau: number): { refused: boolean; reason: string | null } {
  const maxScore = rec.result.retrieval[0]?.score ?? 0;
  if (maxScore < tau) return { refused: true, reason: "low_similarity" };
  if (rec.result.refusalReason === "model_declined") return { refused: true, reason: "model_declined" };
  return { refused: false, reason: null };
}

export interface BucketMetrics {
  bucket: Bucket;
  n: number;
  refusalRate: number | null;
  falseRefusalRate: number | null;
  meanFaithfulness: number | null;
  hitRate: number | null;
  mrr: number | null;
}

export function bucketMetrics(records: RecordedCase[], bucket: Bucket, tau: number): BucketMetrics {
  const cases = records.filter((r) => r.case.bucket === bucket);
  const n = cases.length;
  if (n === 0) {
    return { bucket, n: 0, refusalRate: null, falseRefusalRate: null, meanFaithfulness: null, hitRate: null, mrr: null };
  }

  const outcomes = cases.map((c) => ({ rec: c, out: outcomeAtTau(c, tau) }));
  const refused = outcomes.filter((o) => o.out.refused).length;

  // Refusal rate is only meaningful where refusal is the expected behaviour; false-refusal rate
  // only where answering is. Reporting one without the other is how a refuse-everything agent
  // scores 100%.
  const shouldRefuse = cases.some((c) => c.case.expectedRefusal === true);
  const shouldAnswer = cases.some((c) => c.case.expectedRefusal === false);

  const answered = outcomes.filter((o) => !o.out.refused);
  const faithfulness = answered
    .map((o) => o.rec.result.judge?.score)
    .filter((s): s is number => typeof s === "number");

  const citable = cases.filter((c) => c.case.mustCiteDocIds && c.case.mustCiteDocIds.length > 0);
  const hits = citable.map((c) => rankOfExpectedDoc(c));

  return {
    bucket,
    n,
    refusalRate: shouldRefuse ? refused / n : null,
    falseRefusalRate: shouldAnswer ? refused / n : null,
    meanFaithfulness: faithfulness.length ? mean(faithfulness) : null,
    hitRate: hits.length ? hits.filter((r) => r > 0).length / hits.length : null,
    mrr: hits.length ? mean(hits.map((r) => (r > 0 ? 1 / r : 0))) : null,
  };
}

/** 1-based rank of the first retrieved chunk from an expected document, or 0 if absent. */
export function rankOfExpectedDoc(rec: RecordedCase): number {
  const expected = new Set(rec.case.mustCiteDocIds ?? []);
  if (expected.size === 0) return 0;
  for (let i = 0; i < rec.result.retrieval.length; i++) {
    const chunkId = rec.result.retrieval[i]?.chunkId ?? "";
    const docId = chunkId.split("#")[0] ?? "";
    if (expected.has(docId)) return i + 1;
  }
  return 0;
}

export interface TauPoint {
  tau: number;
  outOfCorpusRefusalRate: number;
  inCorpusFalseRefusalRate: number;
  /** Both metrics matter, so summarise them together rather than optimising one. */
  balancedScore: number;
}

/**
 * Sweep the similarity threshold over recorded scores.
 *
 * This is arithmetic, not inference: retrieval scores are recorded per case, so every threshold
 * can be evaluated without re-querying or re-generating anything. Recording is performed with
 * gate one disabled (tau = 0) precisely so that generation data exists for every case — sweeping
 * *upward* from a recorded tau would otherwise be sound while sweeping downward would not, since
 * cases gated at record time would have no generation result to replay.
 */
export function sweepTau(records: RecordedCase[], taus: number[]): TauPoint[] {
  return taus.map((tau) => {
    const out = bucketMetrics(records, "out_of_corpus", tau).refusalRate ?? 0;
    const inc = bucketMetrics(records, "in_corpus_factual", tau).falseRefusalRate ?? 0;
    return {
      tau,
      outOfCorpusRefusalRate: out,
      inCorpusFalseRefusalRate: inc,
      balancedScore: out - inc,
    };
  });
}

export function tauRange(from = 0.4, to = 0.9, step = 0.01): number[] {
  const out: number[] = [];
  for (let t = from; t <= to + 1e-9; t += step) out.push(Math.round(t * 100) / 100);
  return out;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank: with small eval sets, interpolation invents precision that isn't there.
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? 0;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export interface StageLatency {
  stage: string;
  p50: number;
  p95: number;
}

export function latencies(records: RecordedCase[]): StageLatency[] {
  const stages = ["embedMs", "retrieveMs", "generateMs", "judgeMs", "totalMs"] as const;
  return stages.map((stage) => {
    const values = records
      .map((r) => r.result.timings[stage])
      .filter((v) => typeof v === "number" && v > 0);
    return {
      stage: stage.replace(/Ms$/, ""),
      p50: Math.round(percentile(values, 50)),
      p95: Math.round(percentile(values, 95)),
    };
  });
}

export function totalNeurons(records: RecordedCase[]): number {
  return Math.round(records.reduce((sum, r) => sum + (r.result.neurons ?? 0), 0) * 10) / 10;
}
