import { describe, expect, test } from "bun:test";
import { linkedToken, planWorkspaceCall, runLinkedPlan, type LinkedTarget } from "../gateway/src/linked-workspaces";
import { coveredByTopic, topicWords } from "../gateway/src/share-requests";
import { normalizeToken } from "../gateway/src/policies";

const home = { id: 10, slug: "ani-personal", kind: "personal", name: "Ani's memory" };
const actor = normalizeToken({ name: "oauth:ani:claude", orgId: 10, role: "member", kind: "oauth", email: "ani@example.com", scopes: [] });
const hq: LinkedTarget = { linkId: 1, orgId: 1, name: "Ani HQ", slug: "ani-hq", memberId: 7 };
const lookup = async () => [hq];
const none = async () => [];

describe("planWorkspaceCall", () => {
  test("no workspace argument runs at home, untouched", async () => {
    const args = { query: "deploy" };
    expect(await planWorkspaceCall(home, actor, "recall", args, lookup)).toEqual({ kind: "home", args });
  });

  test("the home slug or an empty value runs at home without the argument", async () => {
    expect(await planWorkspaceCall(home, actor, "recall", { query: "x", workspace: "ani-personal" }, lookup)).toEqual({ kind: "home", args: { query: "x" } });
    expect(await planWorkspaceCall(home, actor, "recall", { query: "x", workspace: "" }, lookup)).toEqual({ kind: "home", args: { query: "x" } });
  });

  test("a linked slug targets that team only, case-insensitively", async () => {
    const plan = await planWorkspaceCall(home, actor, "search", { query: "x", workspace: "Ani-HQ" }, lookup);
    expect(plan).toEqual({ kind: "linked", includeHome: false, targets: [hq], args: { query: "x" } });
  });

  test("an unlinked, unknown or stale slug gets one identical answer", async () => {
    const a = await planWorkspaceCall(home, actor, "recall", { query: "x", workspace: "ani-hq" }, none);
    const b = await planWorkspaceCall(home, actor, "recall", { query: "x", workspace: "no-such-team" }, lookup);
    expect(a.kind).toBe("error");
    expect(b.kind).toBe("error");
    const text = (plan: any) => plan.result.content[0].text.replace(/"[^"]*"/, '"…"');
    expect(text(a)).toBe(text(b));
  });

  test("write tools never run in a linked team", async () => {
    for (const name of ["remember", "put_page", "checkpoint_task", "record_action", "add_tag", "delete_page"]) {
      const plan = await planWorkspaceCall(home, actor, name, { workspace: "ani-hq" }, lookup);
      expect(plan.kind).toBe("error");
    }
  });

  test("\"all\" works only for recall and search, and always includes home", async () => {
    expect(await planWorkspaceCall(home, actor, "recall", { query: "x", workspace: "all" }, lookup)).toEqual({ kind: "linked", includeHome: true, targets: [hq], args: { query: "x" } });
    expect((await planWorkspaceCall(home, actor, "get_page", { slug: "a", workspace: "all" }, lookup)).kind).toBe("error");
  });

  test("teammate requests can be made from a linked team", async () => {
    expect((await planWorkspaceCall(home, actor, "ask_teammate", { teammate: "a@b.co", question: "hello there", workspace: "ani-hq" }, lookup)).kind).toBe("linked");
  });

  test("a console session never resolves links", async () => {
    const session = normalizeToken({ name: "session", orgId: 10, role: "owner", kind: "session", email: "ani@example.com" });
    let looked = false;
    const plan = await planWorkspaceCall(home, session, "recall", { query: "x", workspace: "ani-hq" }, async () => { looked = true; return [hq]; });
    expect(plan.kind).toBe("error");
    expect(looked).toBe(false);
  });

  test("a non-string or oversized workspace is rejected", async () => {
    expect((await planWorkspaceCall(home, actor, "recall", { workspace: 5 }, lookup)).kind).toBe("error");
    expect((await planWorkspaceCall(home, actor, "recall", { workspace: "x".repeat(101) }, lookup)).kind).toBe("error");
  });
});

describe("linkedToken", () => {
  test("is a read-only agent in the team, keeping the connection's scopes", () => {
    const scoped = normalizeToken({ ...actor, scopes: ["memory:read"] });
    expect(linkedToken(scoped, { orgId: 1 })).toEqual({ name: "linked:oauth:ani:claude", orgId: 1, role: "agent", canWrite: false, kind: "oauth", email: "ani@example.com", scopes: ["memory:read"] });
  });
});

describe("runLinkedPlan", () => {
  const team = { id: 1, name: "Ani HQ", slug: "ani-hq", kind: "team" } as any;
  test("labels each result with where it came from and runs as the linked identity", async () => {
    const seen: any[] = [];
    const result = await runLinkedPlan({ kind: "linked", includeHome: true, targets: [hq], args: { query: "deploy" } }, actor, home, 4096, {
      getOrg: async () => team,
      runHome: async (_args, maxBytes) => { seen.push(["home", maxBytes]); return { content: [{ type: "text", text: "home hit" }] }; },
      run: async (org, token, args, maxBytes) => { seen.push([org.slug, token.name, token.canWrite, args, maxBytes]); return { content: [{ type: "text", text: "team hit" }] }; },
    });
    expect(result.isError).toBeUndefined();
    expect(result.content.map((item: any) => item.text)).toEqual([
      "From Ani's memory (ani-personal), this connection's own workspace:", "home hit",
      "From Ani HQ (ani-hq), a linked team, read-only:", "team hit",
    ]);
    expect(seen).toEqual([["home", 2048], ["ani-hq", "linked:oauth:ani:claude", false, { query: "deploy" }, 2048]]);
  });

  test("one failing team does not hide the others", async () => {
    const result = await runLinkedPlan({ kind: "linked", includeHome: true, targets: [hq], args: {} }, actor, home, undefined, {
      getOrg: async () => team,
      runHome: async () => ({ content: [{ type: "text", text: "home hit" }] }),
      run: async () => { throw new Error("engine down"); },
    });
    expect(result.isError).toBeUndefined();
    expect(result.content.at(-1).text).toContain("could not be read right now");
  });

  test("\"all\" with no links says how to link one", async () => {
    const result = await runLinkedPlan({ kind: "linked", includeHome: true, targets: [], args: {} }, actor, home, undefined, {
      getOrg: async () => null, runHome: async () => ({ content: [] }), run: async () => ({ content: [] }),
    });
    expect(result.content.at(-1).text).toContain("list_workspaces");
  });
});

describe("teammate request topics", () => {
  test("a question is covered when it shares at least half the topic's words", () => {
    expect(coveredByTopic("What did we decide about the deploy pipeline rollback?", "deploy pipeline")).toBe(true);
    expect(coveredByTopic("How is hiring going?", "deploy pipeline")).toBe(false);
    expect(coveredByTopic("anything", "the and for")).toBe(false);
  });
  test("topic words drop filler and duplicates", () => {
    expect(topicWords("What did we decide about the Deploy deploy pipeline?")).toEqual(["deploy", "pipeline"]);
  });
});
