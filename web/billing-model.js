const STATUS_LABELS = {
  trial: "Free trial", trial_expired: "Trial ended", active: "Active", trialing: "Trialing",
  past_due: "Payment needs attention", canceled: "Canceled", unpaid: "Payment required",
  incomplete: "Payment incomplete", incomplete_expired: "Checkout expired", paused: "Paused",
  "self-hosted": "Self-hosted",
};

export function billingPresentation(billing) {
  const hosted = billing.mode === "hosted";
  const paid = billing.planId === "cloud";
  const complimentary = hosted && billing.entitlementSource === "complimentary" &&
    billing.canWrite === true && billing.complimentary?.active === true;
  return {
    hosted, paid, complimentary,
    title: hosted ? paid || complimentary ? "Engram Cloud" : "Cloud trial" : "Your infrastructure. Your Engram.",
    label: complimentary ? "Complimentary" : hosted && paid && !billing.canWrite
      ? "Subscription needs attention" : STATUS_LABELS[billing.status] || "Subscription needs attention",
    description: complimentary ? "Complimentary access for this workspace. No subscription is required."
      : hosted ? "One subscription for this workspace. Other workspaces are billed separately."
      : "All core features are available without an Engram subscription.",
    dateLabel: complimentary ? "Access ends" : paid ? billing.cancelAtPeriodEnd ? "Access until" : "Current period ends" : "Trial ends",
    dateValue: complimentary ? billing.complimentary.expiresAt : paid ? billing.currentPeriodEndsAt : billing.trialEndsAt,
    noExpiry: complimentary && billing.complimentary.expiresAt === null,
    showSubscribe: hosted && !complimentary && (!paid || ["canceled", "incomplete_expired"].includes(billing.status)),
    subscriptionLabel: complimentary && billing.portalAvailable && billing.subscriptionStatus
      ? STATUS_LABELS[billing.subscriptionStatus] || "Needs attention" : null,
  };
}
