/**
 * Evaluation history in D1.
 *
 * Durable Object SQLite answers "what happened in this conversation"; D1 answers "how has quality
 * moved across runs". A per-session store cannot answer the second question — it has neither the
 * lifetime nor the cross-session view — so the two stores hold different things on purpose.
 *
 * Writes happen once per recording run, so this is a handful of rows against a 100,000/day free
 * allowance. The read path is what makes the README's numbers queryable rather than pasted.
 */

export interface EvalRunSummary {
  gitSha: string;
  tau: number;
  generatorModel: string;
  judgeModel: string;
  nCases: number;
  refusalRate: number;
  falseRefusalRate: number;
  meanFaithfulness: number;
  hitRate: number;
  mrr: number;
  p50TotalMs: number;
  p95TotalMs: number;
  neurons: number;
}

export interface EvalCaseRow {
  caseId: string;
  bucket: string;
  refused: boolean;
  refusalReason: string | null;
  maxScore: number;
  faithfulness: number | null;
  rankOfExpected: number;
  totalMs: number;
}

export async function writeRun(
  db: D1Database,
  summary: EvalRunSummary,
  cases: EvalCaseRow[],
  recordedAt: number,
): Promise<{ runId: string; cases: number }> {
  const runId = crypto.randomUUID();

  const statements = [
    db
      .prepare(
        `INSERT INTO eval_runs (id, recorded_at, git_sha, tau, generator_model, judge_model,
           n_cases, refusal_rate, false_refusal_rate, mean_faithfulness, hit_rate, mrr,
           p50_total_ms, p95_total_ms, neurons)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        runId,
        recordedAt,
        summary.gitSha,
        summary.tau,
        summary.generatorModel,
        summary.judgeModel,
        summary.nCases,
        summary.refusalRate,
        summary.falseRefusalRate,
        summary.meanFaithfulness,
        summary.hitRate,
        summary.mrr,
        summary.p50TotalMs,
        summary.p95TotalMs,
        summary.neurons,
      ),
    ...cases.map((c) =>
      db
        .prepare(
          `INSERT INTO eval_cases (id, run_id, case_id, bucket, refused, refusal_reason,
             max_score, faithfulness, rank_of_expected, total_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          runId,
          c.caseId,
          c.bucket,
          c.refused ? 1 : 0,
          c.refusalReason,
          c.maxScore,
          c.faithfulness,
          c.rankOfExpected,
          c.totalMs,
        ),
    ),
  ];

  // Batched so a partial write cannot leave a run summary without its cases.
  await db.batch(statements);
  return { runId, cases: cases.length };
}

export async function listRuns(db: D1Database, limit = 20): Promise<unknown[]> {
  const { results } = await db
    .prepare(
      `SELECT id, recorded_at, git_sha, tau, n_cases, refusal_rate, false_refusal_rate,
              mean_faithfulness, hit_rate, mrr, p50_total_ms, p95_total_ms, neurons
       FROM eval_runs ORDER BY recorded_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all();
  return results ?? [];
}
