/**
 * The turn envelope.
 *
 * Imported by the Durable Object, the browser UI, and the evaluation CLI, so the three cannot
 * drift apart. Anything the evaluation panel displays is measured by the eval suite and vice
 * versa, because both read this same shape from the same code path.
 */

export interface RetrievedChunk {
  chunkId: string;
  docTitle: string;
  sourceUrl: string;
  /** Cosine similarity against the query embedding. */
  score: number;
  text: string;
}

export interface StageTimings {
  embedMs: number;
  retrieveMs: number;
  generateMs: number;
  judgeMs: number;
  totalMs: number;
}

export interface JudgeVerdict {
  supported: boolean;
  score: number;
  rationale: string;
  model: string;
}

export type RefusalReason = "low_similarity" | "model_declined";

export interface TurnResult {
  answer: string | null;
  refused: boolean;
  refusalReason: RefusalReason | null;
  retrieval: RetrievedChunk[];
  timings: StageTimings;
  judge: JudgeVerdict | null;
  models: { generator: string; embedder: string; judge: string };
  /** Neurons consumed by this turn — the free plan allows 10,000/day, so it is worth showing. */
  neurons: number;
}

/**
 * Server-sent event names, in pipeline order. Retrieval lands before any answer text so the
 * evidence panel populates first — the user watches the agent find its sources, answer from
 * them, then get graded.
 */
export type TurnEvent =
  | { type: "retrieval"; chunks: RetrievedChunk[]; retrieveMs: number }
  | { type: "token"; delta: string }
  | { type: "refusal"; reason: RefusalReason; maxScore: number; tau: number; message: string }
  | { type: "judge"; verdict: JudgeVerdict }
  | { type: "done"; result: TurnResult }
  | { type: "error"; message: string };

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  /**
   * Set on assistant turns that refused. Refusals are persisted so the conversation reads
   * correctly on reload, but are excluded from the context replayed to the model — a
   * similarity-gated refusal never reached the model, so feeding it back as prior assistant
   * output would be inventing history it never produced.
   */
  refusalReason: RefusalReason | null;
}
