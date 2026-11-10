import { describe, expect, test } from "bun:test";
import { describeShareMatch, renewalEmail } from "../gateway/src/share-rule-expiry";
import { parseShareMatch, publicRule, ruleExpired } from "../gateway/src/sharing";

const match = (value: Record<string, unknown>) => parseShareMatch(value, { allowStoredAll: true });

describe("share rule expiry", () => {
  test("describes what a rule shares in plain words", () => {
    expect(describeShareMatch(match({ matchAll: true }))).toBe("everything new");
    expect(describeShareMatch(match({ topics: ["billing", "auth"] }))).toBe("topics: billing, auth");
    expect(describeShareMatch(match({ trailIds: ["t1"] }))).toBe("one session");
    expect(describeShareMatch(match({ repos: ["engram"], harnesses: ["codex"] }))).toBe("repos: engram; agents: codex");
  });

  test("a rule is expired only once its time has passed", () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    expect(ruleExpired({ expiresAt: "2026-11-10T11:59:59Z" }, now)).toBe(true);
    expect(ruleExpired({ expiresAt: "2026-11-10T12:00:01Z" }, now)).toBe(false);
    expect(ruleExpired({ expiresAt: null }, now)).toBe(false);
  });

  test("the app sees the expiry and whether it has passed", () => {
    const view = publicRule({ id: 1, ownerEmail: "a@example.com", sourceOrg: 1, targetOrg: 2, match: match({ topics: ["x"] }), level: "digest", createdAt: "2026-01-01T00:00:00Z", pausedAt: null, revokedAt: null, expiresAt: "2026-01-02T00:00:00Z" });
    expect(view).toMatchObject({ expiresAt: "2026-01-02T00:00:00Z", expired: true });
    expect(view).not.toHaveProperty("ownerEmail");
  });

  test("one reminder lists every expiring rule and links to Approvals", () => {
    const expiresAt = new Date("2026-11-17T09:00:00Z");
    const mail = renewalEmail([
      { id: 4, ownerEmail: "ada@example.com", teamName: "Ani HQ", match: match({ topics: ["billing"] }), expiresAt },
      { id: 9, ownerEmail: "ada@example.com", teamName: "Lab", match: match({ matchAll: true }), expiresAt },
    ], "https://engram.example/");
    expect(mail.to).toBe("ada@example.com");
    expect(mail.subject).toBe("2 automatic sharing rules stop in a week");
    expect(mail.text).toContain("- To Ani HQ (topics: billing): stops on 17 November 2026");
    expect(mail.text).toContain("- To Lab (everything new)");
    expect(mail.text).toContain("https://engram.example/app#approvals");
    expect(mail.text).toContain("What was already shared stays until you remove it.");
    expect(mail.idempotencyKey).toBe(`share-rule-renewal-4.${expiresAt.getTime() / 1000}-9.${expiresAt.getTime() / 1000}`);
  });

  test("a single rule gets a specific subject", () => {
    const mail = renewalEmail([{ id: 1, ownerEmail: "a@example.com", teamName: "Ani HQ", match: match({ matchAll: true }), expiresAt: new Date() }], "https://e.example");
    expect(mail.subject).toBe("Your automatic sharing to Ani HQ stops in a week");
  });
});
