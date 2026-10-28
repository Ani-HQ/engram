import { h } from "./profile.js";
import { icon } from "./icons.js";
import { relativeTime } from "./activity-view.js";
import { citedSources, confidenceLabel, methodLabel } from "./insight-model.js";
import { statusLabel } from "./status-label.js";

const button = (label, action, attrs = {}) => h("button", { type: "button", onclick: action, ...attrs }, label);
const badge = text => statusLabel(text);
const method = value => badge(methodLabel(value));

export function aiConfiguration(external = {}, { settings = true } = {}) {
  const jev = external.jevConsented === true, other = external.generativeConsented === true || external.consented === true;
  return h("section", { class: "insight-privacy" },
    h("div", {}, h("strong", {}, "Separate choices for external processing")),
    h("p", {}, "Local rules and extractive summaries remain available. Each optional provider needs its own applicable permission and server configuration; Jev also needs available access and budget."),
    h("dl", { class: "insight-config" }, h("div", {}, h("dt", {}, "Jev · TypeSafe"), h("dd", {}, `${jev ? "Permission on" : "Permission off"} · ${external.jevConfigured === true ? "server configured" : "not configured"}`)), h("div", {}, h("dt", {}, "Voyage embeddings"), h("dd", {}, `${other ? "Permission on" : "Permission off"} · ${external.embeddingConfigured === true ? "server configured" : "not configured"}`)), h("div", {}, h("dt", {}, "OpenAI briefs"), h("dd", {}, `${other ? "Permission on" : "Permission off"} · ${external.generativeConfigured === true ? "server configured" : "not configured"}`))),
    settings && h("a", { href: "#workspace", class: "insight-settings-link ds-touch-target" }, "Privacy settings"));
}

function sources(result, ids, onSource) {
  const rows = citedSources(result, ids);
  return h("details", { class: "insight-sources" }, h("summary", {}, `${ids.length} source action${ids.length === 1 ? "" : "s"}`),
    rows.map(source => button([
      h("span", {}, h("strong", {}, source.summary), h("small", {}, `${source.agent} · ${source.tool} · ${source.evidence === "observed" ? "Observed Engram action" : "Agent reported"}`)),
    ], () => onSource(source.activityId, source.id), { class: "insight-source", "aria-label": `Inspect source: ${source.summary}` })),
    rows.length < ids.length && h("p", { class: "detail-note" }, "Some source previews are unavailable. Open the linked activity to inspect its work log."));
}

export function attentionResults(data, { onSource, onActivity, onCopy }) {
  const result = data?.result;
  if (!result) return h("div", { class: "insight-empty" }, h("h2", {}, "Review recorded work"), h("p", {}, "Run checks to find repeated failures, possible overlapping work, and activity awaiting an update. Add a description to find related work and prepare a handoff brief. Each finding links to its source activity."));
  const findings = result.insights || [];
  return h("div", { class: "attention-content" },
    h("div", { class: "insight-result-meta" }, h("span", {}, `${findings.length} finding${findings.length === 1 ? "" : "s"}`), h("span", {}, "Latest check · ", relativeTime(result.generatedAt))),
    result.coverage && h("p", { class: "insight-coverage" }, `${result.coverage.actionsChecked} recorded actions checked`, result.coverage.truncated ? ` · Limited to the latest ${result.coverage.maxActions}; older activity was not included.` : " · Activity outside Engram’s coverage is not included."),
    result.search && h("section", { class: "insight-search-results" },
      h("div", { class: "insight-section-heading" }, h("h2", {}, "Related work"), method(result.search.method)),
      h("p", { class: "detail-note" }, result.search.method === "model" ? "Model-ranked matches for your intent. Inspect the cited actions before relying on the match." : "Text matches across recorded summaries, approaches, tools, and resources. External semantic search was not used."),
      h("p", { class: "insight-query" }, result.search.query),
      (result.search.matches || []).map(match => button([h("span", {}, match.summary)], () => onSource(match.activityId, match.actionId), { class: "insight-search-match" })),
      !result.search.matches?.length && h("p", { class: "detail-note" }, "No matches in the checked activity. Try a more specific word or phrase.")),
    h("section", { class: "insight-findings", "aria-label": "Findings to inspect" }, findings.length ? findings.map(finding => h("article", { class: "insight-card" },
      h("div", { class: "insight-card-top" },
        h("div", {}, h("h2", {}, finding.title), h("p", { class: "insight-methods" }, method(finding.method), finding.method === "model" && confidenceLabel(finding.confidence) && [" · ", badge(confidenceLabel(finding.confidence))]))),
      h("p", { class: "insight-description" }, finding.description),
      finding.method === "model" && h("p", { class: "insight-caveat" }, "Confidence is the model’s judgment strength, not a verified probability."),
      sources(result, finding.sources || [], onSource),
      h("div", { class: "insight-card-actions" }, (finding.activityIds || []).map((id, index) => button(["Open activity", finding.activityIds.length > 1 ? ` ${index + 1}` : ""], () => onActivity(id), { class: "text small" }))),
    )) : h("div", { class: "insight-clear" }, h("div", {}, h("h2", {}, "No findings in the checked activity"), h("p", {}, "This means the available checks found no matching patterns. Activity outside Engram’s coverage is not included.")))),
    result.brief && h("section", { class: "insight-brief" }, h("div", { class: "insight-section-heading" }, h("h2", {}, "Handoff brief"), method(result.brief.method)),
      h("p", { class: "detail-note" }, result.brief.method === "model" ? `Generated from cited actions${result.brief.model ? ` with ${result.brief.model}` : ""}. Verify it before sharing.` : "An extract from recorded work and results, without generated conclusions."),
      h("p", { class: "insight-brief-text" }, result.brief.text), sources(result, result.brief.sources || [], onSource),
      button("Copy brief", () => onCopy(result.brief.text), { class: "small" })),
    result.provenance?.length > 0 && h("details", { class: "insight-provenance" }, h("summary", {}, "Model provenance"), result.provenance.map(record => h("dl", { class: "insight-config" },
      h("div", {}, h("dt", {}, "Requested model"), h("dd", {}, record.requestedModel)), h("div", {}, h("dt", {}, "Response model"), h("dd", {}, record.modelReported ? record.reportedModel : "Provider did not report a model")), h("div", {}, h("dt", {}, "Question version"), h("dd", {}, record.questionVersion))))),
    h("p", { class: "insight-private-note" }, "Results and source links are scoped to this workspace."));
}
