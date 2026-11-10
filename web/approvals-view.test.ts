import { describe, expect, test } from "bun:test";
import { outcomeLabel, ruleState, timeLeft } from "./approvals-view.js";

const now = Date.parse("2026-11-10T12:00:00Z");
const days = (n: number) => new Date(now + n * 86_400_000).toISOString();

describe("approvals view", () => {
  test("a sharing rule says whether it is on, ending soon, paused or expired", () => {
    expect(ruleState({ expiresAt: days(30) }, now)).toMatchObject({ label: "On", tone: "neutral" });
    expect(ruleState({ expiresAt: days(3) }, now)).toMatchObject({ label: "Ends soon", tone: "warning" });
    expect(ruleState({ expiresAt: days(3), pausedAt: days(-1) }, now)).toMatchObject({ label: "Paused", tone: "neutral" });
    const expired = ruleState({ expiresAt: days(-2) }, now);
    expect(expired.label).toBe("Expired");
    expect(expired.line).toContain("Nothing new is shared.");
    expect(ruleState({ expiresAt: days(10), expired: true }, now).label).toBe("Expired");
  });

  test("request time left and outcomes read plainly", () => {
    expect(timeLeft(new Date(now + 3 * 3_600_000).toISOString(), now)).toBe("3 hours left");
    expect(timeLeft(new Date(now - 1).toISOString(), now)).toBe("Lapsed");
    expect(outcomeLabel({ status: "answered", automatic: true })).toBe("Answered automatically");
    expect(outcomeLabel({ status: "declined" })).toBe("Declined");
  });
});
