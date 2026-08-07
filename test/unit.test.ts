/**
 * Deterministic unit tests — no network, no bindings, no credentials.
 *
 * These run on every pull request including forks. They cover the pure logic that decides what
 * retrieval can find and how results are scored, because those are the places where a bug
 * produces a *plausible* number rather than an obvious failure.
 *
 * Run:  npm test
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { chunkDocument, parseCorpusFile, type CorpusDoc } from "../src/agent/chunk.ts";
import { parseVerdict, extractText, JUDGE } from "../src/agent/judge.ts";
import { declined, neuronsFor, replayableContext, INSUFFICIENT } from "../src/agent/generate.ts";
import { belowThreshold, DEFAULT_TAU } from "../src/agent/retrieve.ts";
import { refusalMessage, CORPUS_SCOPE } from "../src/shared/scope.ts";

const doc = (body: string): CorpusDoc => ({
  id: "d",
  title: "Doc",
  sourceUrl: "https://example.test/d",
  body,
});

describe("chunkDocument", () => {
  test("keeps a short document as a single chunk", () => {
    const chunks = chunkDocument(doc("One paragraph only."));
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]?.text, "One paragraph only.");
    assert.equal(chunks[0]?.id, "d#0");
  });

  test("splits on paragraph boundaries once the target is exceeded", () => {
    const para = "x".repeat(700);
    const chunks = chunkDocument(doc([para, para, para].join("\n\n")), {
      targetChars: 1000,
      overlapChars: 0,
    });
    assert.ok(chunks.length >= 2, `expected a split, got ${chunks.length}`);
    // No chunk should begin mid-paragraph.
    for (const c of chunks) assert.ok(c.text.startsWith("x"));
  });

  test("never splits inside a paragraph, even one over the target", () => {
    const huge = "y".repeat(5000);
    const chunks = chunkDocument(doc(huge), { targetChars: 1000, overlapChars: 0 });
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]?.text.length, 5000);
  });

  test("carries overlap forward so a fact spanning a seam stays retrievable", () => {
    const a = `${"a".repeat(600)}IMPORTANT_FACT`;
    const b = "b".repeat(600);
    const chunks = chunkDocument(doc([a, b].join("\n\n")), {
      targetChars: 700,
      overlapChars: 40,
    });
    assert.ok(chunks.length >= 2);
    assert.ok(
      chunks[1]?.text.includes("IMPORTANT_FACT"),
      "the tail of chunk 0 should reappear at the head of chunk 1",
    );
  });

  test("assigns stable ids so re-ingest upserts rather than duplicates", () => {
    const body = Array.from({ length: 6 }, () => "z".repeat(500)).join("\n\n");
    const first = chunkDocument(doc(body));
    const second = chunkDocument(doc(body));
    assert.deepEqual(
      first.map((c) => c.id),
      second.map((c) => c.id),
    );
  });
});

describe("parseCorpusFile", () => {
  test("reads front-matter and strips it from the body", () => {
    const raw = [
      "---",
      "id: my-doc",
      'title: "A Title"',
      "source_url: https://example.test/x",
      "---",
      "",
      "Body text here.",
    ].join("\n");
    const parsed = parseCorpusFile(raw, "fallback");
    assert.equal(parsed.id, "my-doc");
    assert.equal(parsed.title, "A Title");
    assert.equal(parsed.sourceUrl, "https://example.test/x");
    assert.equal(parsed.body, "Body text here.");
  });

  test("falls back cleanly when front-matter is absent", () => {
    const parsed = parseCorpusFile("Just body.", "fallback-id");
    assert.equal(parsed.id, "fallback-id");
    assert.equal(parsed.body, "Just body.");
  });
});

describe("judge / extractText", () => {
  test("reads the documented { response } shape", () => {
    assert.equal(extractText({ response: "hello" }), "hello");
  });

  test("reads the OpenAI Responses shape, ignoring the reasoning item", () => {
    const text = extractText({
      response: "",
      output: [
        { type: "reasoning", content: [{ type: "reasoning_text", text: "thinking out loud" }] },
        { type: "message", content: [{ type: "output_text", text: '{"supported":true}' }] },
      ],
    });
    assert.equal(text, '{"supported":true}');
    assert.ok(!text.includes("thinking out loud"));
  });

  test("reads the choices shape", () => {
    assert.equal(extractText({ choices: [{ message: { content: "from choices" } }] }), "from choices");
  });

  test("names its own failure when the shape is unrecognised", () => {
    const text = extractText({ usage: { prompt_tokens: 1 } });
    assert.match(text, /unrecognised response shape/);
    assert.notEqual(text.trim(), "", "must never return empty — that hides the cause");
  });
});

describe("judge / parseVerdict", () => {
  test("parses a clean verdict", () => {
    const v = parseVerdict('{"supported": true, "score": 0.9, "rationale": "ok"}');
    assert.equal(v.supported, true);
    assert.equal(v.score, 0.9);
    assert.equal(v.model, JUDGE);
  });

  test("finds the verdict after reasoning prose containing braces", () => {
    const raw = `Let me think. The set {a, b} is mentioned.
Final answer:
{"supported": false, "score": 0.25, "rationale": "only partly stated"}`;
    const v = parseVerdict(raw);
    assert.equal(v.supported, false);
    assert.equal(v.score, 0.25);
  });

  test("clamps scores into range", () => {
    assert.equal(parseVerdict('{"supported":true,"score":5}').score, 1);
    assert.equal(parseVerdict('{"supported":true,"score":-2}').score, 0);
  });

  test("NEVER defaults to supported when output is unparseable", () => {
    // A judge that fails open turns breakage into a perfect score — the exact failure this
    // project exists to detect.
    for (const raw of ["", "garbage", "{not json}", "{}"]) {
      const v = parseVerdict(raw);
      assert.equal(v.supported, false, `"${raw}" must not be treated as supported`);
      assert.equal(v.score, 0);
    }
  });

  test("reports the raw output so breakage is diagnosable", () => {
    assert.match(parseVerdict("total garbage").rationale, /unparseable judge output/);
    assert.match(parseVerdict("").rationale, /\(empty\)/);
  });
});

describe("refusal gates", () => {
  test("gate one fires strictly below tau", () => {
    assert.equal(belowThreshold(0.61, 0.62), true);
    assert.equal(belowThreshold(0.62, 0.62), false);
    assert.equal(belowThreshold(0.63, 0.62), false);
  });

  test("gate one defaults to the committed tau", () => {
    assert.equal(belowThreshold(DEFAULT_TAU - 0.01), true);
    assert.equal(belowThreshold(DEFAULT_TAU + 0.01), false);
  });

  test("gate two detects the sentinel regardless of case or surrounding space", () => {
    assert.equal(declined(INSUFFICIENT), true);
    assert.equal(declined(`  ${INSUFFICIENT}  `), true);
    assert.equal(declined("insufficient_context"), true);
    assert.equal(declined("The transfer lock is 60 days [1]."), false);
  });

  test("gate two does not fire on an answer that merely mentions the concept", () => {
    assert.equal(declined("There is insufficient detail about pricing, but the lock is 60 days."), false);
  });
});

describe("neuron accounting", () => {
  test("weights output far above input", () => {
    const inputHeavy = neuronsFor(1000, 0);
    const outputHeavy = neuronsFor(0, 1000);
    assert.ok(outputHeavy > inputHeavy * 7, "output tokens cost ~7.7x input");
  });

  test("is zero for an empty turn", () => {
    assert.equal(neuronsFor(0, 0), 0);
  });
});

describe("replayableContext", () => {
  const msg = (
    role: "user" | "assistant",
    content: string,
    refusalReason: "low_similarity" | "model_declined" | null = null,
  ) => ({ id: content, role, content, createdAt: 0, refusalReason });

  test("keeps ordinary question/answer pairs", () => {
    const ctx = replayableContext([msg("user", "q1"), msg("assistant", "a1")]);
    assert.deepEqual(ctx, [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ]);
  });

  test("drops a refusal and the question that produced it", () => {
    // A gated refusal never reached the model; replaying it would invent model output.
    const ctx = replayableContext([
      msg("user", "out of corpus"),
      msg("assistant", "Refused.", "low_similarity"),
      msg("user", "q2"),
      msg("assistant", "a2"),
    ]);
    assert.deepEqual(ctx, [
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
    ]);
  });

  test("drops sentinel refusals too", () => {
    const ctx = replayableContext([
      msg("user", "unanswerable"),
      msg("assistant", "Refused.", "model_declined"),
    ]);
    assert.deepEqual(ctx, []);
  });

  test("never leaves a user turn with no answer after it", () => {
    // An orphan question reads as an unanswered request and invites a belated answer.
    const ctx = replayableContext([
      msg("user", "q1"),
      msg("assistant", "Refused.", "low_similarity"),
    ]);
    assert.equal(ctx.filter((m) => m.role === "user").length, 0);
  });
});

describe("refusalMessage", () => {
  test("names the scope, so a refusal redirects instead of dead-ending", () => {
    const m = refusalMessage("low_similarity", 0.596, 0.62);
    assert.match(m, /Cloudflare Registrar/);
    assert.match(m, /0\.596/);
    assert.match(m, /0\.62/);
  });

  test("distinguishes the two gates", () => {
    const gated = refusalMessage("low_similarity", 0.4, 0.62);
    const declined = refusalMessage("model_declined", 0.8, 0.62);
    assert.match(gated, /nothing in the corpus is close enough/i);
    assert.match(declined, /none of them answer/i);
    assert.notEqual(gated, declined);
  });

  test("never claims an answer was produced", () => {
    for (const r of ["low_similarity", "model_declined"] as const) {
      assert.match(refusalMessage(r, 0.5, 0.62), /^Refused/);
    }
  });
});
