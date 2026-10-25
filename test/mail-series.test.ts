import { describe, expect, test } from "bun:test";
process.env.ENGRAM_DB_URL_TEMPLATE ??= "postgresql://postgres:postgres@localhost:1/__DB__";
const { mailSeriesProof, mailStepComplete, preflightMailSeries } = await import("../gateway/src/mail-series");

describe("onboarding mail safety decisions", () => {
  test("delivery is explicit opt-in and missing configuration fails closed", () => {
    expect(preflightMailSeries({})).toEqual({ enabled: false, ready: true, missing: [] });
    expect(preflightMailSeries({ ENGRAM_ONBOARDING_EMAILS: "1" }).ready).toBe(false);
    const configured = { ENGRAM_ONBOARDING_EMAILS: "1", ENGRAM_MAIL_UNSUBSCRIBE_KEY: "local-test-key-32-bytes-or-longer!!", RESEND_API_KEY: "test-only", ENGRAM_DEPLOYMENT_MODE: "hosted", ENGRAM_PUBLIC_URL: "https://engram.example" };
    expect(preflightMailSeries(configured).ready).toBe(true);
    for (const url of ["http://engram.example", "https://user:password@engram.example", "javascript:alert(1)"]) expect(preflightMailSeries({ ...configured, ENGRAM_PUBLIC_URL: url }).ready).toBe(false);
  });
  test("proofs are domain separated, deterministic and differ by enrollment and key", () => {
    const id = "a0b1c2d3-1234-4abc-8abc-0123456789ab";
    const proof = mailSeriesProof(id, "test-key");
    expect(proof).toMatch(/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(mailSeriesProof(id, "test-key")).toBe(proof);
    expect(mailSeriesProof(id, "other-key")).not.toBe(proof);
    expect(mailSeriesProof("b0b1c2d3-1234-4abc-8abc-0123456789ab", "test-key")).not.toBe(proof);
  });
  test("each reminder needs the actual corresponding progress", () => {
    expect(mailStepComplete("welcome", { agents: 2, saved: true, recalled: true })).toBe(false);
    expect(mailStepComplete("connect-agent", { agents: 0, saved: false, recalled: false })).toBe(false);
    expect(mailStepComplete("first-memory", { agents: 1, saved: true, recalled: false })).toBe(false);
    expect(mailStepComplete("first-memory", { agents: 1, saved: true, recalled: true })).toBe(true);
    expect(mailStepComplete("second-agent", { agents: 1, saved: true, recalled: true })).toBe(false);
    expect(mailStepComplete("second-agent", { agents: 2, saved: false, recalled: false })).toBe(true);
  });
});
