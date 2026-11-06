import { describe, expect, test } from "bun:test";
import { operatorAnalytics } from "../gateway/src/site-analytics";
import { handleOrgApi } from "../gateway/src/org-api";
import { normalizeToken } from "../gateway/src/policies";
import { analyticsSummary } from "../web/analytics-view.js";

function fakeDb(people: unknown[]) {
  const db: any = (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("FROM firsts")) return Promise.resolve(people);
    if (text.includes("generate_series")) return Promise.resolve([{ day: "2026-11-05", pageviews: 6, visitors: 2, signup_forms: 1 }]);
    if (text.includes("count(*) FILTER (WHERE name = 'pageview')::int AS pageviews")) return Promise.resolve([{ pageviews: 6, visitor_days: 2, signups_submitted: 1 }]);
    if (text.includes("WITH cohort")) return Promise.resolve([{ workspaces_created: 1 }]);
    return Promise.resolve(text.includes("now() - make_interval") && !text.includes("SELECT") ? [] : []);
  };
  return db;
}

describe("operator analytics", () => {
  test("lists new people with how they joined and what they did", async () => {
    const data = await operatorAnalytics(30, fakeDb([
      { email: "a@example.com", joined_at: "2026-11-04T10:00:00Z", workspace: "a's memory", kind: "personal", role: "owner", used_invite: true, agent_connected: true, saved_memory: false },
      { email: "b@example.com", joined_at: "2026-11-03T10:00:00Z", workspace: "Team", kind: "team", role: "member", used_invite: false, agent_connected: false, saved_memory: false },
    ]));
    expect(data.people.map(p => [p.email, p.how, p.agentConnected, p.savedMemory])).toEqual([
      ["a@example.com", "invite code", true, false], ["b@example.com", "team invite", false, false]]);
    expect(data.daily).toHaveLength(1);
  });

  test("only the signup operator can read it", async () => {
    const owner = normalizeToken({ name: "ada", orgId: 7, role: "owner", kind: "session", email: "ada@example.com" });
    const req = new Request("https://engram.example/api/admin/analytics?days=30");
    const org = { id: 7, name: "W", slug: "w", kind: "team", brainDb: "b", dataDb: "b", homeDir: "h", policies: {} } as any;
    expect((await handleOrgApi(req, new URL(req.url), owner, org))?.status).toBe(403);
  });

  test("summary says whether anyone signed up", () => {
    expect(analyticsSummary({ traffic: { pageviews: 3 }, people: [] }).anyoneSignedUp).toBe(false);
    const summary = analyticsSummary({ traffic: { pageviews: 3, visitor_days: 2, signups_submitted: 1 }, funnel: { workspaces_created: 1, with_agent_call: 1 }, people: [{ email: "a@example.com" }] });
    expect([summary.anyoneSignedUp, summary.newPeople, summary.signupForms, summary.funnel[1].value]).toEqual([true, 1, 1, 1]);
  });
});
