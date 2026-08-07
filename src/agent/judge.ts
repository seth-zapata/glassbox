/**
 * Faithfulness judging.
 *
 * Scores whether the answer is actually supported by the passages it was given — not whether it
 * is true in the world. Those come apart exactly where it matters: a model can produce a correct
 * statement that the corpus does not support, which is still a grounding failure, because next
 * time the same behaviour produces an incorrect one.
 *
 * Deliberately a different model family from the generator. LLM-as-judge has a well-documented
 * self-preference bias, and a model grading its own output inflates the headline number for free.
 */

import type { JudgeVerdict, RetrievedChunk } from "../shared/types.ts";

export const JUDGE = "@cf/openai/gpt-oss-20b";

export const NEURONS_PER_M = { in: 18_182, out: 27_273 } as const;

const SYSTEM = `You grade whether an ANSWER is supported by the PASSAGES.

Judge only support, not truth. If the answer is factually correct but the passages do not state it, that is NOT supported.

Reply with strict JSON and nothing else:
{"supported": true|false, "score": 0.0-1.0, "rationale": "one sentence"}

score is the fraction of the answer's claims that the passages support.`;

export interface JudgeResult {
  verdict: JudgeVerdict;
  judgeMs: number;
  neurons: number;
}

/**
 * Workers AI response shapes are not uniform across models.
 *
 * The documented shape for this model is `{ response: string }`, and that field comes back
 * *empty* for gpt-oss — it is a reasoning model and returns the OpenAI Responses format, where
 * the answer lives in an `output` array alongside a separate reasoning item. Rather than pin the
 * judge to one vendor's current shape, extract from any of the shapes Workers AI actually
 * returns, so swapping the judge model does not silently zero the faithfulness metric.
 */
export interface JudgeResponse {
  response?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
    text?: string;
  }>;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function extractText(response: JudgeResponse): string {
  if (typeof response.response === "string" && response.response.trim()) {
    return response.response;
  }

  // OpenAI Responses format: prefer the message item, ignoring the reasoning item.
  if (Array.isArray(response.output)) {
    const parts: string[] = [];
    for (const item of response.output) {
      if (item.type === "reasoning") continue;
      if (typeof item.text === "string") parts.push(item.text);
      for (const c of item.content ?? []) {
        if (typeof c.text === "string") parts.push(c.text);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }

  const choice = response.choices?.[0]?.message?.content;
  if (typeof choice === "string" && choice.trim()) return choice;

  // Nothing recognisable — return the serialized shape so the failure names its own cause.
  return `[unrecognised response shape] ${JSON.stringify(response).slice(0, 300)}`;
}

export async function judge(
  ai: Ai,
  question: string,
  answer: string,
  chunks: RetrievedChunk[],
): Promise<JudgeResult> {
  const started = Date.now();
  const passages = chunks.map((c, i) => `[${i + 1}] ${c.text}`).join("\n\n");

  const response = (await ai.run(JUDGE, {
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `PASSAGES:\n${passages}\n\nQUESTION: ${question}\n\nANSWER: ${answer}`,
      },
    ],
    max_tokens: 1500,
  })) as JudgeResponse;

  const judgeMs = Date.now() - started;
  const raw = extractText(response);

  const verdict = parseVerdict(raw);
  const usage = response.usage ?? {};
  const neurons =
    ((usage.prompt_tokens ?? 0) * NEURONS_PER_M.in +
      (usage.completion_tokens ?? 0) * NEURONS_PER_M.out) /
    1_000_000;

  return { verdict, judgeMs, neurons };
}

/**
 * Extract the verdict from the model's reply.
 *
 * A judge that fails to parse must not silently count as "supported" — that would quietly turn
 * a broken judge into a perfect score, which is the failure mode this whole project is about.
 * Unparseable output is recorded as unsupported with score 0 and a rationale saying so, making
 * judge breakage visible in the metrics instead of flattering them.
 */
export function parseVerdict(raw: string): JudgeVerdict {
  // Match flat objects rather than greedily spanning the first `{` to the last `}`. Reasoning
  // models emit prose — sometimes containing braces — before the verdict, and a greedy match
  // swallows all of it and fails to parse. The schema is flat, so this is sufficient, and the
  // last match is taken because the verdict comes after any reasoning.
  const candidates = raw.match(/\{[^{}]*\}/g) ?? [];

  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate) as {
        supported?: unknown;
        score?: unknown;
        rationale?: unknown;
      };
      if (typeof parsed.supported !== "boolean" && typeof parsed.score !== "number") continue;
      const score = typeof parsed.score === "number" ? Math.max(0, Math.min(1, parsed.score)) : 0;
      return {
        supported: parsed.supported === true,
        score,
        rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
        model: JUDGE,
      };
    } catch {
      // Try the next candidate.
    }
  }

  // Never fall back to "supported" — a broken judge that defaults to passing turns itself into a
  // perfect score, which is precisely the failure this project exists to detect. Carry a slice of
  // the raw output so the breakage is diagnosable rather than merely visible.
  return {
    supported: false,
    score: 0,
    rationale: `unparseable judge output: ${raw.slice(0, 180).replace(/\s+/g, " ").trim() || "(empty)"}`,
    model: JUDGE,
  };
}
