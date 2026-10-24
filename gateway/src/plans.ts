// Product prices are explicit and reviewable. Stripe Price IDs stay server-side.
export const TRIAL_DAYS = 14;
export const PLANS = [
  {
    id: "self-hosted", name: "Self-hosted", monthlyPrice: 0, currency: "usd", unit: "your infrastructure",
    description: "Run Engram on infrastructure you control.",
    features: ["All core features", "Unlimited connected agents", "Your database and access controls", "No Engram subscription or billing calls"],
  },
  {
    id: "cloud", name: "Cloud", monthlyPrice: 19, currency: "usd", unit: "workspace / month",
    description: "Your private workspace, hosted by Engram.",
    features: ["All core features", "Unlimited connected agents", "Isolated workspace data", "Cancel any time"],
  },
] as const;

export type PaidPlanId = "cloud";

export function paidPlan(value: unknown): PaidPlanId | null {
  return value === "cloud" ? value : null;
}
