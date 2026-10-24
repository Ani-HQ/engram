import { expect, test } from "bun:test";
import { billingPresentation } from "./billing-model.js";

const trial = { mode: "hosted", planId: "trial", status: "trial_expired", canWrite: false, trialEndsAt: "2026-10-20T00:00:00Z" };
const comp = { ...trial, planId: "complimentary", status: "complimentary", entitlementSource: "complimentary", canWrite: true, complimentary: { active: true, expiresAt: null } };

test("non-expiring complimentary access does not present the old trial end or a checkout", () => {
  expect(billingPresentation(comp)).toMatchObject({ title: "Engram Cloud", label: "Complimentary", complimentary: true, noExpiry: true, dateLabel: "Access ends", dateValue: null, showSubscribe: false });
  expect(billingPresentation(comp).description).toContain("No subscription is required");
  const expiresAt = "2026-12-01T00:00:00Z";
  expect(billingPresentation({ ...comp, complimentary: { active: true, expiresAt } })).toMatchObject({ noExpiry: false, dateValue: expiresAt, showSubscribe: false });
});

test("a grant cannot hide an existing Stripe subscription or its portal", () => {
  for (const subscriptionStatus of ["active", "past_due", "canceled"]) {
    const result = billingPresentation({ ...comp, portalAvailable: true, subscriptionStatus });
    expect(result.subscriptionLabel).toBeTruthy();
    expect(result.showSubscribe).toBe(false);
  }
  expect(billingPresentation(comp).subscriptionLabel).toBeNull();
});

test("inactive or inconsistent grant metadata does not grant a complimentary display state", () => {
  for (const patch of [{ canWrite: false }, { complimentary: null }, { complimentary: { active: false, expiresAt: null } }, { entitlementSource: "none" }]) {
    expect(billingPresentation({ ...comp, ...patch }).complimentary).toBe(false);
    expect(billingPresentation({ ...comp, ...patch }).noExpiry).toBe(false);
  }
});

test("expired trial, paid cancellation and self-hosted behavior stay distinct", () => {
  expect(billingPresentation(trial)).toMatchObject({ label: "Trial ended", noExpiry: false, dateValue: trial.trialEndsAt, showSubscribe: true });
  expect(billingPresentation({ ...trial, planId: "cloud", status: "active", canWrite: true, cancelAtPeriodEnd: true, currentPeriodEndsAt: "2026-11-01T00:00:00Z" })).toMatchObject({ title: "Engram Cloud", label: "Active", dateLabel: "Access until", dateValue: "2026-11-01T00:00:00Z", showSubscribe: false });
  expect(billingPresentation({ mode: "self-hosted", planId: "self-hosted", status: "self-hosted", canWrite: true })).toMatchObject({ hosted: false, label: "Self-hosted", complimentary: false, showSubscribe: false });
});
