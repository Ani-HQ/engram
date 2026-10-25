import { h } from "./profile.js";
import { icon } from "./icons.js";

const title = "Reading your memory…";
const waiting = "Still loading this memory. You can close this panel and try again.";

function targetLabel(slug) {
  if (typeof slug !== "string") return "";
  const text = slug.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  const characters = Array.from(text);
  return characters.length > 120 ? `${characters.slice(0, 119).join("")}…` : text;
}

const paragraph = short => h("div", { class: `memory-loading-paragraph${short ? " short" : ""}` },
  h("span", { class: "ds-skeleton" }), h("span", { class: "ds-skeleton" }), h("span", { class: "ds-skeleton" }), !short && h("span", { class: "ds-skeleton" }));

// The page arrives in one response. The scaffold expresses waiting, never
// staged progress, inferred content, or a completed part of the request.
export function memoryLoading(slug) {
  const target = targetLabel(slug);
  return h("section", { class: "memory-loading", role: "status", "aria-busy": "true", "aria-live": "polite", "aria-atomic": "false" },
    h("header", { class: "memory-loading-header" },
      h("div", { class: "memory-loading-kicker", "aria-hidden": "true" }, icon("file-text", { size: 14 }), "Memory"),
      h("h2", { id: "detail-title", class: "memory-loading-title" }, title),
      h("p", { class: "memory-loading-subtitle" }, "Retrieving the content and links saved in this memory."),
      target && h("p", { class: "memory-loading-target" }, target)),
    h("div", { class: "memory-loading-sheet", "aria-hidden": "true" },
      h("div", { class: "memory-loading-sheet-title ds-skeleton" }),
      h("div", { class: "memory-loading-metadata" }, h("span", { class: "ds-skeleton" }), h("span", { class: "ds-skeleton" })),
      h("div", { class: "memory-loading-rule" }), paragraph(false), paragraph(true)),
    h("p", { class: "memory-loading-delayed", hidden: true }, waiting));
}

// The drawer owns the timer and request lifecycle. Repeated calls do not
// rewrite live text or generate recurring screen-reader announcements.
export function setMemoryLoadingDelayed(node, delayed = true) {
  const note = node?.querySelector(".memory-loading-delayed");
  if (!note) return false;
  if (note.hidden !== !delayed) note.hidden = !delayed;
  return true;
}
