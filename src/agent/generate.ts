/**
 * Prompt construction and the grounded generation call.
 *
 * Gate two of two. Retrieval can return chunks that are topically close but do not actually
 * answer the question — the case that produces a confident, well-sourced, wrong answer. The
 * similarity gate cannot catch that, because the scores look fine. So the model is instructed to
 * emit a sentinel instead of answering, and the sentinel is treated as a refusal.
 */

import type { RetrievedChunk } from "../shared/types.ts";

export const GENERATOR = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export const NEURONS_PER_M = { in: 26_668, out: 204_805 } as const;

/** Output tokens cost 7.7× input, so the answer length cap is the main lever on spend. */
export const MAX_TOKENS = 300;

export const INSUFFICIENT = "INSUFFICIENT_CONTEXT";

const SYSTEM = `You answer questions about domain registration using ONLY the numbered passages provided.

Rules:
- Use only facts stated in the passages. Never use outside knowledge, even if you are confident it is correct.
- Cite the passages you used by number, like [1] or [2][4].
- If the passages do not contain enough information to answer, reply with exactly ${INSUFFICIENT} and nothing else.
- If the question rests on a false premise that the passages contradict, correct the premise.
- If the question is ambiguous, say what is ambiguous and what you would need to know.
- Be concise: at most four sentences.`;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export function buildMessages(
  question: string,
  chunks: RetrievedChunk[],
  history: ChatMessage[],
): ChatMessage[] {
  const passages = chunks
    .map((c, i) => `[${i + 1}] (${c.docTitle})\n${c.text}`)
    .join("\n\n");

  return [
    { role: "system", content: SYSTEM },
    // History is included so follow-ups resolve, but trimmed: it competes with passages for
    // context, and passages are what grounds the answer.
    ...history.slice(-4),
    { role: "user", content: `Passages:\n\n${passages}\n\nQuestion: ${question}` },
  ];
}

/** A model that emitted the sentinel declined to answer; anything else is an answer. */
export function declined(answer: string): boolean {
  return answer.trim().toUpperCase().startsWith(INSUFFICIENT);
}

export function neuronsFor(promptTokens: number, completionTokens: number): number {
  return (promptTokens * NEURONS_PER_M.in + completionTokens * NEURONS_PER_M.out) / 1_000_000;
}
