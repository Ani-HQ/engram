import { icon } from "./icons.js";
import { h } from "./profile.js";

const historyFilters = ["q", "agent", "tool", "status", "resource", "runId"];

// Legacy Attention links now address the Checks section of Activity.
export function activityDestination(rawView, params = new URLSearchParams()) {
  if (rawView === "attention") return { view: "activity", activityTab: "checks" };
  const tab = params.get("tab");
  return { view: rawView, activityTab: rawView === "activity" && ["checks", "handoffs"].includes(tab) ? tab : "history" };
}

export function activityHref({ tab = "history", kind = "all", filters = {}, query = "", activityId = "" } = {}) {
  const params = new URLSearchParams();
  if (tab === "handoffs") params.set("tab", "handoffs");
  else if (tab === "checks") {
    params.set("tab", "checks");
    if (typeof query === "string" && query) params.set("q", query);
    if (typeof activityId === "string" && activityId) params.set("activityId", activityId);
  } else {
    if (["tasks", "memory"].includes(kind)) params.set("kind", kind);
    for (const key of historyFilters) if (typeof filters[key] === "string" && filters[key]) params.set(key, filters[key]);
  }
  return `#activity${params.size ? `?${params}` : ""}`;
}

export function activitySections({ tab = "history", historyHref = "#activity", checksHref = "#activity?tab=checks", handoffsHref = "#activity?tab=handoffs" } = {}) {
  const selected = ["checks", "handoffs"].includes(tab) ? tab : "history";
  return h("nav", { class: "ds-tabs activity-section-tabs", "aria-label": "Activity views" },
    [["history", "History", historyHref, "history"], ["handoffs", "Handoffs", handoffsHref, "route"], ["checks", "Checks", checksHref, "badge-check"]].map(([key, label, href, glyph]) => h("a", {
      href, class: "ds-tab", "aria-current": selected === key ? "page" : null, "data-activity-section": key,
    }, icon(glyph, { size: 15 }), label)));
}
