import { describe, expect, test } from "bun:test";
import { choiceOf, noulYes, noulValue, scoreOf } from "../gateway/src/reflex/answers";
import { TypesafeReflexClient } from "../gateway/src/reflex/client";
import { mapPool } from "../gateway/src/reflex/pool";
import { retryDelayMs } from "../gateway/src/reflex/retry";
import { parseClassification } from "../gateway/src/reflex/tasks/classify";
import { parsePairwise } from "../gateway/src/reflex/tasks/pairwise";
import { parseRerank } from "../gateway/src/reflex/tasks/rerank";
import { parseTopicRoute as parseTopic } from "../gateway/src/reflex/tasks/topic-route";
import { rerankRecallHits } from "../gateway/src/reflex/recall";
import type { ReflexAnswer } from "../gateway/src/reflex/types";

process.env.ENGRAM_DB_URL_TEMPLATE ??= "postgresql://postgres:postgres@localhost:1/__DB__";
process.env.TYPESAFE_API_KEY = "test-key";

describe("reflex answers", () => {
  test("choiceOf requires confidence", () => {
    const answers: Record<string, ReflexAnswer> = {
      topic: { type: "choice", choice: "projects/engram", confidence: 0.8 },
    };
    expect(choiceOf(answers, "topic", 0.55)).toBe("projects/engram");
    expect(choiceOf(answers, "topic", 0.9)).toBeNull();
  });

  test("noulYes rejects a coin flip", () => {
    const answers: Record<string, ReflexAnswer> = { sensitive: { type: "noul", noul: 0.51 } };
    expect(noulYes(answers, "sensitive", 0.55)).toBe(false);
    expect(noulValue({ sensitive: { type: "noul", noul: 0.9 } }, "sensitive", 0.55)).toBe(0.9);
  });

  test("scoreOf returns the numeric score", () => {
    expect(scoreOf({ h0: { type: "score", score: 2.1, confidence: 0.8 } }, "h0", 0.55)).toBe(2.1);
    expect(scoreOf({ h0: { type: "score", score: 2.1, confidence: 0.2 } }, "h0", 0.55)).toBeNull();
  });
});

describe("reflex pool and retry", () => {
  test("mapPool preserves order", async () => {
    const out = await mapPool([1, 2, 3, 4], async item => {
      await Bun.sleep(item === 1 ? 10 : 0);
      return item * 2;
    }, 2);
    expect(out).toEqual([2, 4, 6, 8]);
  });

  test("retryDelayMs honours Retry-After", () => {
    expect(retryDelayMs(1, 2)).toBe(2000);
    expect(retryDelayMs(3)).toBe(8000);
  });
});

describe("reflex parsers", () => {
  test("parses a topic route only for known candidates", () => {
    const candidates = [{ slug: "projects/engram", title: "engram" }];
    expect(parseTopic({
      topic: { type: "choice", choice: "projects/engram", confidence: 0.9 },
    }, candidates, 0.55)).toBe("projects/engram");
    expect(parseTopic({
      topic: { type: "choice", choice: "none", confidence: 0.9 },
    }, candidates, 0.55)).toBeNull();
  });

  test("parses classification and pairwise relations", () => {
    const classified = parseClassification({
      kind: { type: "choice", choice: "decision", confidence: 0.8 },
      importance: { type: "score", score: 2, confidence: 0.7 },
      longevity: { type: "choice", choice: "durable", confidence: 0.8 },
      sensitivity: { type: "noul", noul: 0.1 },
      actionability: { type: "noul", noul: 0.9 },
    }, "jev-latest", 0.55);
    expect(classified.kind).toBe("decision");
    expect(classified.longevity).toBe("durable");
    expect(parsePairwise({
      relation: { type: "choice", choice: "contradict", confidence: 0.77 },
    }, 0.55)).toEqual({ relation: "contradict", confidence: 0.77 });
  });

  test("rerank leaves original order when confidence is low", () => {
    expect(parseRerank({
      h0: { type: "score", score: 3, confidence: 0.1 },
      h1: { type: "score", score: 1, confidence: 0.1 },
    }, 2, 0.55)).toBeNull();
    expect(parseRerank({
      h0: { type: "score", score: 1, confidence: 0.8 },
      h1: { type: "score", score: 3, confidence: 0.8 },
    }, 2, 0.55)?.map(row => row.index)).toEqual([1, 0]);
  });
});

describe("reflex client", () => {
  test("retries 429 then succeeds", async () => {
    let calls = 0;
    const client = new TypesafeReflexClient(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("slow down", { status: 429, headers: { "retry-after": "0.01" } });
      }
      return Response.json({
        model: "jev-latest",
        answers: { kind: { type: "choice", choice: "fact", confidence: 0.9 } },
      });
    }, Date.now, { apiKey: "test-key" });
    const result = await client.evaluate({
      state: { memory: "x" },
      questions: { kind: { type: "choice", instructions: "x", criteria: { fact: "fact" } } },
    });
    expect(result?.answers.kind).toEqual({ type: "choice", choice: "fact", confidence: 0.9 });
    expect(calls).toBe(2);
  });

  test("hard-disables on 401", async () => {
    const client = new TypesafeReflexClient(async () => new Response("no", { status: 401 }), Date.now, { apiKey: "test-key" });
    expect(await client.evaluate({ state: {}, questions: { a: { type: "noul", instructions: "x" } } })).toBeNull();
    expect(client.available()).toBe(false);
  });
});

describe("recall rerank fallback", () => {
  test("keeps search order when Jev is unavailable", async () => {
    const hits = [
      { slug: "a", snippet: "one" },
      { slug: "b", snippet: "two" },
      { slug: "c", snippet: "three" },
    ];
    const out = await rerankRecallHits("q", hits, 2);
    expect(out.map(hit => hit.slug)).toEqual(["a", "b"]);
  });
});
