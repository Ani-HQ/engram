import { describe, expect, test } from "bun:test";
import { runWithContext } from "../gateway/src/context";
import { buildFreshnessQuestions, buildTaskMatchQuestions, judgeFreshness, judgeTaskMatches } from "../gateway/src/continuation-jev";
import { normalizeToken, parsePolicies } from "../gateway/src/policies";

const token = normalizeToken({ name: "codex", orgId: 7 });
const org = (jevProcessing: boolean) => ({ id: 7, name: "Lab", slug: "lab", kind: "team" as const, brainDb: "brain_org_7", homeDir: "org-7", dataDb: "brain_org_7", policies: parsePolicies({ jevProcessing }) });
const inContext = <T>(jev: boolean, work: () => Promise<T>) => runWithContext({ org: org(jev), token, dataSql: null as any }, work);
function fakeClient(answer: (input: any) => any, { available = true, delay = 0 } = {}) {
  const calls: any[] = [];
  return { calls, factory: () => ({ enabled: () => true, available: () => available, async evaluate(input: any) { calls.push(input); if (delay) await new Promise(r => setTimeout(r, delay)); return { model: "jev", answers: answer(input) }; } }) as any };
}

const candidates = [
  { id: "task_a", title: "Pricing page copy refresh", project: "site", objective: "Rewrite pricing around one flat plan.", next: "Draft headlines." },
  { id: "task_b", title: "Fix flaky invite test", project: "engram", objective: "Make the invite test deterministic.", next: "Freeze the clock." },
];

describe("task matching", () => {
  test("never runs without Jev consent or an available client", async () => {
    const client = fakeClient(() => ({}));
    expect(await inContext(false, () => judgeTaskMatches("the pricing thing", candidates, client.factory))).toBeNull();
    expect(await inContext(true, () => judgeTaskMatches("the pricing thing", candidates, fakeClient(() => ({}), { available: false }).factory))).toBeNull();
    expect(client.calls).toHaveLength(0);
  });

  test("returns confident scores by task ID and labels the request as untrusted data", async () => {
    const client = fakeClient(() => ({ t0: { type: "score", score: 3, confidence: 0.9 }, t1: { type: "score", score: 0, confidence: 0.9 } }));
    const scores = await inContext(true, () => judgeTaskMatches("continue the pricing thing", candidates, client.factory));
    expect([...scores!.entries()]).toEqual([["task_a", 3], ["task_b", 0]]);
    expect(client.calls[0].task).toBe("task-match");
    expect(client.calls[0].state.task).toContain("untrusted");
  });

  test("a late provider answer is ignored and the caller falls back", async () => {
    const client = fakeClient(() => ({ t0: { type: "score", score: 3, confidence: 0.9 } }), { delay: 1500 });
    expect(await inContext(true, () => judgeTaskMatches("pricing", candidates, client.factory))).toBeNull();
  });

  test("input stays bounded", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `task_${i}`, title: "t".repeat(500), objective: "o".repeat(2000), next: "n".repeat(2000) }));
    const built = buildTaskMatchQuestions("q".repeat(5000), many);
    expect(built.candidates.length).toBeLessThanOrEqual(12);
    expect(Buffer.byteLength(JSON.stringify({ state: built.state, questions: built.questions }))).toBeLessThan(12_288);
  });
});

describe("freshness", () => {
  const decisions = ["Store checkpoints in workspace storage.", "Use a flat team price of $49."];
  const memories = [{ slug: "projects/pricing", text: "Decision: the team price is now $29 flat." }, { slug: "notes/lunch", text: "Lunch order for Friday." }];

  test("only pairs sharing a meaningful word are compared", () => {
    const built = buildFreshnessQuestions(decisions, memories);
    expect(built.pairs).toEqual([{ decision: 1, memory: 0 }]);
  });

  test("confident supersede or contradict judgments become warnings; others do not", async () => {
    const client = fakeClient(() => ({ r0: { type: "choice", choice: "supersede", confidence: 0.9 } }));
    expect(await inContext(true, () => judgeFreshness(decisions, memories, client.factory))).toEqual([{ decision: 1, memory: "projects/pricing", relation: "supersede" }]);
    const unsure = fakeClient(() => ({ r0: { type: "choice", choice: "supersede", confidence: 0.1 } }));
    expect(await inContext(true, () => judgeFreshness(decisions, memories, unsure.factory))).toEqual([]);
    expect(client.calls[0].task).toBe("freshness");
  });

  test("no overlapping pairs means no provider call", async () => {
    const client = fakeClient(() => ({}));
    expect(await inContext(true, () => judgeFreshness(["Use Postgres."], [{ slug: "x", text: "Lunch order." }], client.factory))).toEqual([]);
    expect(client.calls).toHaveLength(0);
  });
});
