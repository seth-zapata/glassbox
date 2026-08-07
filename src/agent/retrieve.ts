/**
 * Embedding and retrieval, plus the similarity gate.
 *
 * Gate one of two (see generate.ts for the second). This one is deterministic and costs nothing:
 * if nothing in the corpus is similar enough to the question, the turn refuses before a single
 * token is generated. Cheap to run, cheap to tune, and — because the threshold is a number rather
 * than a model behaviour — it can be swept offline against recorded scores.
 */

import type { RetrievedChunk } from "../shared/types.ts";

export const EMBEDDER = "@cf/baai/bge-base-en-v1.5";

/** Six chunks at ~400 tokens fits the 24k context with room for history and the system prompt. */
export const TOP_K = 6;

/**
 * Similarity threshold. Below this, the turn refuses.
 *
 * Provisional until the sweep in `eval:replay` reports the refusal / false-refusal tradeoff
 * against the committed eval set. Recorded fixtures make re-tuning free — retrieval scores are
 * stored per case, so changing this does not require re-querying or re-generating anything.
 */
export const DEFAULT_TAU = 0.62;

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  maxScore: number;
  embedMs: number;
  retrieveMs: number;
  /** Neurons attributable to the embedding call. */
  neurons: number;
}

const NEURONS_PER_M_EMBED_IN = 6_058;

export async function embed(ai: Ai, text: string): Promise<{ vector: number[]; tokens: number }> {
  const result = (await ai.run(EMBEDDER, { text: [text] })) as {
    data: number[][];
    shape?: number[];
  };
  const vector = result.data[0];
  if (!vector) throw new Error("embedding model returned no vector");
  // The model does not report token usage; approximate for the neuron estimate.
  return { vector, tokens: Math.ceil(text.length / 4) };
}

export async function retrieve(
  ai: Ai,
  index: VectorizeIndex,
  question: string,
  topK: number = TOP_K,
): Promise<RetrievalResult> {
  const embedStarted = Date.now();
  const { vector, tokens } = await embed(ai, question);
  const embedMs = Date.now() - embedStarted;

  const retrieveStarted = Date.now();
  const matches = await index.query(vector, { topK, returnMetadata: "all" });
  const retrieveMs = Date.now() - retrieveStarted;

  const chunks: RetrievedChunk[] = (matches.matches ?? []).map((m) => {
    const meta = (m.metadata ?? {}) as Record<string, string>;
    return {
      chunkId: m.id,
      docTitle: meta.docTitle ?? "",
      sourceUrl: meta.sourceUrl ?? "",
      score: m.score ?? 0,
      text: meta.text ?? "",
    };
  });

  return {
    chunks,
    maxScore: chunks[0]?.score ?? 0,
    embedMs,
    retrieveMs,
    neurons: (tokens * NEURONS_PER_M_EMBED_IN) / 1_000_000,
  };
}

/** Gate one. Deterministic, and the only refusal path that costs nothing. */
export function belowThreshold(maxScore: number, tau: number = DEFAULT_TAU): boolean {
  return maxScore < tau;
}
