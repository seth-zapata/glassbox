-- Evaluation history.
--
-- Durable Object SQLite holds "what happened in this conversation"; D1 holds "how has quality
-- moved across runs". Different questions, different lifetimes — a per-session store cannot
-- answer whether faithfulness regressed between two deploys.

CREATE TABLE IF NOT EXISTS eval_runs (
  id                     TEXT PRIMARY KEY,
  recorded_at            INTEGER NOT NULL,
  git_sha                TEXT NOT NULL,
  tau                    REAL NOT NULL,
  generator_model        TEXT NOT NULL,
  judge_model            TEXT NOT NULL,
  n_cases                INTEGER NOT NULL,
  refusal_rate           REAL NOT NULL,
  false_refusal_rate     REAL NOT NULL,
  mean_faithfulness      REAL NOT NULL,
  hit_rate               REAL NOT NULL,
  mrr                    REAL NOT NULL,
  p50_total_ms           INTEGER NOT NULL,
  p95_total_ms           INTEGER NOT NULL,
  neurons                REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_cases (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES eval_runs(id),
  case_id       TEXT NOT NULL,
  bucket        TEXT NOT NULL,
  refused       INTEGER NOT NULL,
  refusal_reason TEXT,
  max_score     REAL NOT NULL,
  faithfulness  REAL,
  rank_of_expected INTEGER NOT NULL,
  total_ms      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eval_cases_run ON eval_cases(run_id);
CREATE INDEX IF NOT EXISTS idx_eval_runs_time ON eval_runs(recorded_at DESC);
