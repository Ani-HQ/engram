import { describe, expect, test } from "bun:test";
import { config } from "../gateway/src/config";
import { runWithContext } from "../gateway/src/context";
import { normalizeToken, parsePolicies } from "../gateway/src/policies";
import { createRecallReranker, RECALL_PLAN_CAPACITY, RECALL_PLAN_INFLIGHT, RECALL_PLAN_TTL_MS } from "../gateway/src/reflex/recall";
import { prepareRecallCandidates, recallPassages, sourceHash } from "../gateway/src/reflex/passages";
import { buildPassageRerankQuestions, buildRerankQuestions, MAX_RERANK_INPUT_BYTES, parsePassageRerank } from "../gateway/src/reflex/tasks/rerank";
import { TypesafeReflexClient } from "../gateway/src/reflex/client";
import { sanitizeProviderInput } from "../gateway/src/reflex/sanitize";
import type { ReflexClient, ReflexResult } from "../gateway/src/reflex/types";

function context(id = 7, name = "codex", enabled = true) {
  return { org: { id, name: "Fixture", slug: `fixture-${id}`, kind: "team" as const, brainDb: `brain_org_${id}`, dataDb: `brain_org_${id}`, homeDir: `org-${id}`, policies: parsePolicies({ jevProcessing: enabled }) },
    token: normalizeToken({ orgId: id, name, canWrite: true }), dataSql: {} as any };
}
const inOrg = <T>(work: () => T, id = 7, name = "codex", enabled = true) => runWithContext(context(id, name, enabled), work);
const fixtureHits = () => [
  { slug: "notes/boilerplate", chunk_text: "Generic project scaffolding and unrelated startup work." },
  { slug: "projects/retries", chunk_text: "Welcome to the old setup guide. ".repeat(100) + "\nDecision: retry background jobs with the same stable request ID. Never create duplicate jobs.\n", content_hash: "a".repeat(64) },
];
function answersFor(input: any): ReflexResult {
  return { model: "jev-1.13.0", answers: Object.fromEntries(Object.entries<any>(input.questions).map(([key, question]) => {
    const index = Number(key.slice(1)), passages = input.state.candidates[index].passages;
    const best = passages.findIndex((passage: any) => passage.text.includes("stable request ID"));
    return [key, question.type === "score" ? { type: "score", score: best >= 0 ? 3 : 1, confidence: 0.95 }
      : { type: "choice", choice: `p${best >= 0 ? best : 0}`, confidence: 0.95 }];
  })) };
}
function fakeClient(evaluate = async (input: any) => answersFor(input)) {
  let calls = 0;
  const inputs: any[] = [];
  const client: ReflexClient = { enabled: () => true, available: () => true, evaluate: async input => { calls++; inputs.push(input); return evaluate(input); } };
  return { client, inputs, calls: () => calls };
}

describe("bounded Jev passage retrieval", () => {
  test("finds an existing late decision after boilerplate and returns exact source citations", async () => {
    const fixture = fakeClient(), rerank = createRecallReranker({ client: () => fixture.client });
    const hits = fixtureHits(), before = structuredClone(hits);
    const output = await inOrg(() => rerank("background job retry request ID", hits, 2));
    expect(fixture.calls()).toBe(1);
    expect(output[0].slug).toBe("projects/retries");
    expect(output[0].chunk_text).toContain("stable request ID");
    expect(output[0].chunk_text.length).toBeLessThanOrEqual(180);
    const citation = (output[0] as any).recall_passage;
    expect(citation.offset).toBeGreaterThan(320);
    expect(citation.source_hash).toBe(sourceHash(hits[1].chunk_text));
    expect(output[0].chunk_text).toBe(hits[1].chunk_text.slice(citation.offset, citation.offset + citation.length));
    expect(output[0].content_hash).toBe(hits[1].content_hash);
    expect(hits).toEqual(before);
  });
  test("deduplicates content before the provider and sends passages only once under the input ceiling", async () => {
    const fixture = fakeClient(), rerank = createRecallReranker({ client: () => fixture.client });
    const hits = Array.from({ length: 30 }, (_, i) => ({ slug: `notes/${i}`, chunk_text: `Unique ${Math.floor(i / 2)}. ` + "🧠Long Unicode memory. ".repeat(150) }));
    const output = await inOrg(() => rerank("Unicode memory", hits, 5));
    const input = fixture.inputs[0];
    expect(input.state.candidates.length).toBeLessThanOrEqual(10);
    expect(input.state.candidates.length).toBeLessThanOrEqual(16);
    expect(Object.keys(input.questions).length).toBeLessThanOrEqual(32);
    expect(Buffer.byteLength(JSON.stringify({ state: input.state, questions: input.questions, model: config.reflex.model }))).toBeLessThanOrEqual(MAX_RERANK_INPUT_BYTES);
    for (const question of Object.values<any>(input.questions)) expect(JSON.stringify(question.instructions)).not.toContain("Long Unicode memory");
    for (const candidate of input.state.candidates) { expect(candidate.passages.length).toBeLessThanOrEqual(3); for (const passage of candidate.passages) expect(passage.text.length).toBeLessThanOrEqual(180); }
    expect(new Set(output.map(hit => hit.chunk_text)).size).toBe(output.length);
  });
  test("redaction expansion cannot exceed the actual provider wire budget", async () => {
    const query = "query";
    const hits = Array.from({ length: 20 }, (_, index) => ({ slug: `notes/${index}`, chunk_text:
      `Head${index} ` + "http://a ".repeat(70) + `query Middle${index} ` + "http://b ".repeat(70) + `Tail${index} ` + "http://c ".repeat(70) }));
    const { candidates, ...input } = buildPassageRerankQuestions(query, prepareRecallCandidates(query, hits));
    // Before admission accounted for redaction, this fixture admitted 13 rows:
    // 11,530 raw bytes expanded to 13,012 bytes at the actual transport boundary.
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThan(13);
    for (const value of [input, sanitizeProviderInput(input)]) {
      expect(Buffer.byteLength(JSON.stringify({ ...value as object, model: config.reflex.model }))).toBeLessThanOrEqual(MAX_RERANK_INPUT_BYTES);
    }
    const bodies: string[] = [];
    const client = new TypesafeReflexClient(async (_url, options) => {
      bodies.push(String(options?.body));
      const sent = JSON.parse(bodies[0]);
      return Response.json({ ...answersFor(sent), model: config.reflex.model, usage: { input_tokens: 10, output_tokens: 2 } });
    }, Date.now, { apiKey: "fixture-key-never-real", model: config.reflex.model });
    const rerank = createRecallReranker({ client: () => client });
    const output = await inOrg(() => rerank(query, hits, 2));
    expect(bodies).toHaveLength(1);
    expect(Buffer.byteLength(bodies[0])).toBeLessThanOrEqual(MAX_RERANK_INPUT_BYTES);
    expect(bodies[0]).not.toContain("http://a");
    expect(bodies[0]).toContain("[resource]");
    expect(output).toHaveLength(2);
    expect((output[0] as any).recall_passage).toBeDefined();
  });
  test("coalesces concurrent same-scope work and reuses only validated index plans", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fixture = fakeClient(async input => { await gate; return answersFor(input); });
    const rerank = createRecallReranker({ client: () => fixture.client });
    const one = inOrg(() => rerank("retry", fixtureHits(), 2)), two = inOrg(() => rerank("retry", fixtureHits(), 2));
    expect(fixture.calls()).toBe(1);
    release();
    const [first, second] = await Promise.all([one, two]);
    expect(first).toEqual(second);
    const current = fixtureHits().map(hit => ({ ...hit, fresh: "new authorized metadata" }));
    const cached = await inOrg(() => rerank("retry", current, 2));
    expect(fixture.calls()).toBe(1);
    expect(cached[0].fresh).toBe("new authorized metadata");
  });
  test("revoked effective consent/access and unavailable clients cannot use a cached plan", async () => {
    const fixture = fakeClient(), rerank = createRecallReranker({ client: () => fixture.client });
    await inOrg(() => rerank("retry", fixtureHits(), 2));
    expect(fixture.calls()).toBe(1);
    const noConsent = await inOrg(() => rerank("retry", fixtureHits(), 2), 7, "codex", false);
    expect(noConsent).toEqual(fixtureHits());
    fixture.client.available = () => false;
    const unavailable = await inOrg(() => rerank("retry", fixtureHits(), 2));
    expect(unavailable).toEqual(fixtureHits());
    expect(fixture.calls()).toBe(1);
    expect(await rerank("retry", fixtureHits(), 2)).toEqual(fixtureHits());
  });
  test("cache separates changed content, tenant, actor, query, model and policy", async () => {
    const fixture = fakeClient(), rerank = createRecallReranker({ client: () => fixture.client });
    await inOrg(() => rerank("retry", fixtureHits(), 2));
    const changed = fixtureHits(); changed[1].chunk_text += "Updated policy.";
    await inOrg(() => rerank("retry", changed, 2));
    await inOrg(() => rerank("retry", fixtureHits(), 2), 8);
    await inOrg(() => rerank("retry", fixtureHits(), 2), 7, "claude-code");
    await inOrg(() => rerank("request ID", fixtureHits(), 2));
    const priorModel = config.reflex.model;
    try { config.reflex.model = priorModel === "jev-latest" ? "jev-1.13.0" : "jev-latest"; await inOrg(() => rerank("retry", fixtureHits(), 2)); }
    finally { config.reflex.model = priorModel; }
    const policy = context(); policy.org.policies.acceptShares = false;
    await runWithContext(policy, () => rerank("retry", fixtureHits(), 2));
    expect(fixture.calls()).toBe(7);
  });
  test("TTL and bounded LRU evict plans rather than retaining source data forever", async () => {
    let now = 1000;
    const fixture = fakeClient(), rerank = createRecallReranker({ client: () => fixture.client, now: () => now });
    await inOrg(() => rerank("retry", fixtureHits(), 1));
    now += RECALL_PLAN_TTL_MS;
    await inOrg(() => rerank("retry", fixtureHits(), 1));
    expect(fixture.calls()).toBe(2);
    for (let i = 0; i < RECALL_PLAN_CAPACITY; i++) await inOrg(() => rerank(`query-${i}`, fixtureHits(), 1));
    await inOrg(() => rerank("retry", fixtureHits(), 1));
    expect(fixture.calls()).toBe(RECALL_PLAN_CAPACITY + 3);
  });
  test("malformed or low-confidence selections cannot invent excerpts or enter cache", async () => {
    for (const invalid of ["p99", "-1", "p0 injected text", "none"]) {
      const fixture = fakeClient(async input => ({ ...answersFor(input), answers: Object.fromEntries(Object.keys(input.questions).map(key => [key, key.startsWith("h") ? { type: "score", score: 3, confidence: 0.99 } : { type: "choice", choice: invalid, confidence: 0.99 }])) } as ReflexResult));
      const rerank = createRecallReranker({ client: () => fixture.client });
      expect(await inOrg(() => rerank("retry", fixtureHits(), 2))).toEqual(fixtureHits());
      expect(await inOrg(() => rerank("retry", fixtureHits(), 2))).toEqual(fixtureHits());
      expect(fixture.calls()).toBe(2);
    }
    const candidates = prepareRecallCandidates("retry", fixtureHits());
    expect(parsePassageRerank({ h0: { type: "score", score: 3, confidence: 0.1 }, p0: { type: "choice", choice: "p0", confidence: 0.99 } }, candidates)).toBeNull();
  });
  test("timeout is bounded at 400ms and late answers never become a cached plan", async () => {
    let resolve!: (value: ReflexResult) => void;
    const fixture = fakeClient(() => new Promise<ReflexResult>(done => { resolve = done; }));
    const rerank = createRecallReranker({ client: () => fixture.client });
    const started = performance.now();
    expect(await inOrg(() => rerank("retry", fixtureHits(), 2))).toEqual(fixtureHits());
    expect(performance.now() - started).toBeLessThan(650);
    resolve(answersFor(fixture.inputs[0]));
    await Bun.sleep(5);
    const pending = inOrg(() => rerank("retry", fixtureHits(), 2));
    expect(fixture.calls()).toBe(2);
    resolve(answersFor(fixture.inputs[1]));
    await pending;
  });
  test("in-flight capacity abstains instead of multiplying provider work", async () => {
    const releases: Array<() => void> = [];
    const fixture = fakeClient(input => new Promise<ReflexResult>(resolve => { releases.push(() => resolve(answersFor(input))); }));
    const rerank = createRecallReranker({ client: () => fixture.client });
    const work = Array.from({ length: RECALL_PLAN_INFLIGHT }, (_, index) => inOrg(() => rerank(`task-${index}`, fixtureHits(), 2)));
    expect(await inOrg(() => rerank("overflow", fixtureHits(), 2))).toEqual(fixtureHits());
    expect(fixture.calls()).toBe(RECALL_PLAN_INFLIGHT);
    releases.forEach(release => release());
    await Promise.all(work);
  });
  test("real client transport validates typed answers, redacts provider input and transmits once", async () => {
    let calls = 0, body: any;
    const client = new TypesafeReflexClient(async (_url, init) => {
      calls++; body = JSON.parse(String(init?.body));
      return Response.json({ ...answersFor(body), usage: { input_tokens: 100, output_tokens: 10 } });
    }, Date.now, { apiKey: "fixture-key", model: "jev-1.13.0" });
    const rerank = createRecallReranker({ client: () => client });
    const hits = fixtureHits(); hits[1].chunk_text += '{"password":"secret-value"} user@example.com';
    const output = await inOrg(() => rerank("background job request ID", hits, 2));
    expect(calls).toBe(1);
    expect(JSON.stringify(body)).not.toContain("secret-value");
    expect(JSON.stringify(body)).not.toContain("user@example.com");
    expect(output[0].chunk_text).toContain("stable request ID");
    expect(output[0].slug).toBe("projects/retries");
  });
  test("real client rejects invented passage indices without installing a plan", async () => {
    let calls = 0;
    const client = new TypesafeReflexClient(async (_url, init) => {
      calls++;
      const input = JSON.parse(String(init?.body)), value = answersFor(input);
      for (const key of Object.keys(value.answers)) if (key.startsWith("p")) value.answers[key] = { type: "choice", choice: "p99", confidence: 0.99 };
      return Response.json({ ...value, usage: { input_tokens: 100, output_tokens: 10 } });
    }, Date.now, { apiKey: "fixture-key", model: "jev-1.13.0" });
    const rerank = createRecallReranker({ client: () => client });
    expect(await inOrg(() => rerank("retry", fixtureHits(), 2))).toEqual(fixtureHits());
    expect(await inOrg(() => rerank("retry", fixtureHits(), 2))).toEqual(fixtureHits());
    expect(calls).toBe(2);
  });
  test("Unicode boundaries and scan limits retain exact source spans", () => {
    const body = "🧠".repeat(40000) + "Last correction: retry request ID remains stable.";
    const passages = recallPassages("retry request ID", body);
    expect(passages.some(passage => passage.text.includes("Last correction"))).toBe(true);
    for (const passage of passages) { expect(passage.text).toBe(body.slice(passage.offset, passage.offset + passage.length)); expect(passage.text).not.toContain("�"); expect(passage.length).toBeLessThanOrEqual(180); }
    const prepared = buildPassageRerankQuestions("🧠".repeat(1000), prepareRecallCandidates("retry", Array.from({ length: 20 }, (_, i) => ({ chunk_text: `unique ${i}` + body }))));
    expect(Object.keys(prepared.questions).length).toBeLessThanOrEqual(32);
    expect(Buffer.byteLength(JSON.stringify({ state: prepared.state, questions: prepared.questions, model: config.reflex.model }))).toBeLessThanOrEqual(MAX_RERANK_INPUT_BYTES);
  });
  test("offline duplicate-heavy evaluation measures input and context sizes without cost claims", () => {
    const query = "retry stable request ID", texts = Array.from({ length: 20 }, (_, index) => `Project ${Math.floor(index / 2)}. ${"Setup guide. ".repeat(260)}Decision: retry background jobs with the same stable request ID. Never create duplicate jobs.`);
    const previous = buildRerankQuestions(query, texts);
    const { candidates, ...next } = buildPassageRerankQuestions(query, prepareRecallCandidates(query, texts.map(chunk_text => ({ chunk_text }))));
    expect(Buffer.byteLength(JSON.stringify(previous))).toBe(18608);
    expect(Buffer.byteLength(JSON.stringify(next))).toBe(6797);
    expect(candidates.length).toBe(10);
    expect(Object.keys(next.questions).length).toBe(20);
    expect(texts.every(text => !text.slice(0, 320).includes("stable request ID"))).toBe(true);
    expect(candidates.every(candidate => candidate.passages.some(passage => passage.text.includes("stable request ID")))).toBe(true);
  });
});
