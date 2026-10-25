import { h } from "./profile.js";
import { icon } from "./icons.js";
import { agentVisual, toolVisual, serviceVisual, visualIcon } from "./tooling.js";
import { resourceChip } from "./design-system.js";
import { activityPresentation, actionPresentation, resourcePresentation, chronologicalActions, contributorName } from "./activity-presentation.js";

const plural = (count, word) => `${count} ${count === 1 ? word : word === "approach" ? "approaches" : `${word}s`}`;
const button = (children, action, attrs = {}) => h("button", { type: "button", onclick: action, ...attrs }, children);
const validDate = value => { if (!value) return null; const date = new Date(value); return Number.isNaN(date.valueOf()) ? null : date; };
export function relativeTime(value, now = Date.now()) {
  const date = validDate(value);
  if (!date) return "Time unavailable";
  const seconds = Math.max(0, Math.floor((now - date.valueOf()) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}
function exactTime(value) {
  const date = validDate(value);
  return date ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(date) : "Time unavailable";
}
function clockTime(value) {
  const date = validDate(value);
  return date ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date) : "—";
}
function dateLabel(value) {
  const date = validDate(value);
  if (!date) return "Earlier";
  const today = new Date(), yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" }).format(date);
}
export function activityStatus(activity, { compact = false } = {}) {
  const state = ["running", "failed", "completed"].includes(activity.status) ? activity.status : "unknown";
  const stale = state === "running" && !activity.workingActions && activity.staleActions > 0;
  const label = stale ? "Awaiting update" : { running: "In progress", completed: "Completed", failed: "Needs attention", unknown: "Unknown" }[state];
  return h("span", { class: `activity-status ds-badge ${state}${stale ? " stale" : ""}${compact ? " compact" : ""}`, "data-tone": stale ? "warning" : { running: "info", completed: "success", failed: "danger", unknown: "neutral" }[state], title: label, "aria-label": label },
    icon(stale ? "clock" : { running: compact ? "circle-dot" : "loader-circle", completed: "check-check", failed: "circle-x", unknown: "circle-help" }[state], { size: 13, class: state === "running" && activity.workingActions > 0 && !compact ? "working-spinner" : "" }), label);
}
export function agentAvatar(name, { working = false, size = "", label = false, harness, sourceLabel, displayName } = {}) {
  const visual = agentVisual(name, { harness, sourceLabel });
  return h("span", { class: `activity-avatar ${size}${working ? " is-working" : ""}`, title: displayName && displayName !== name ? `${displayName} · ${name}` : name, "aria-hidden": label ? null : "true" },
    visual.brand || visual.label === "Codex" ? visualIcon(visual, { size: size === "large" ? 19 : size === "row" ? 18 : 14 }) : h("span", {}, visual.initials),
    working && h("span", { class: "avatar-working-dot" }));
}
function agentChip(agent, onFilter, currentFilter, { avatar = true } = {}) {
  const working = agent.workingActions > 0;
  return button([avatar && agentAvatar(agent.name, { ...agent, working }), h("span", {}, contributorName(agent))],
    () => onFilter?.("agent", currentFilter === agent.name ? "" : agent.name), { class: `activity-agent-chip${avatar ? "" : " text-only"}`, title: `${agent.name}${agent.sourceLabel || agent.harness ? ` · Reported source: ${agent.sourceLabel || agent.harness}` : ""}`, "aria-label": `Filter activity by ${contributorName(agent)}`, "aria-pressed": String(currentFilter === agent.name), "data-focus-key": `agent:${agent.name}` });
}
function toolChip(tool, onFilter, active = false, extraClass = "") {
  const visual = toolVisual(tool);
  return button([visualIcon(visual, { size: 13 }), h("span", {}, visual.label)], () => onFilter("tool", active ? "" : tool),
    { class: `activity-tool-chip ${extraClass}`, title: tool, "aria-label": `Filter by ${tool}`, "aria-pressed": String(active), "data-focus-key": `tool:${tool}` });
}
export function activityFilters(stats, selected, onChange) {
  return h("div", { class: "activity-switcher", role: "group", "aria-label": "Activity status" },
    [["", "All statuses", stats.total], ["running", "In progress", stats.running], ["completed", "Completed", stats.completed], ["failed", "Needs attention", stats.failed]].map(([value, label, count]) =>
      button([value === "running" && h("span", { class: "filter-live-dot", "aria-hidden": "true" }), label, h("span", { class: "filter-count" }, count ?? "—")], () => onChange(value), { class: "activity-filter-tab", "aria-pressed": String(selected === value), "data-activity-status": value })));
}
function resourceControl(resource, activity, onResource, { action = null, primary = false, concise = false } = {}) {
  const label = resource.kind === "memory" ? "Open memory" : resource.kind === "url" ? "Open resource" : "Copy resource";
  const chip = resourceChip(concise ? label : resource.label, {
    visual: visualIcon(serviceVisual(resource.service), { size: 16 }),
    trailing: onResource ? icon(resource.kind === "resource" ? "copy" : "arrow-up-right", { size: 12 }) : null,
    onClick: onResource ? () => onResource(resource, { activity, action }) : undefined,
    title: onResource ? `${label}: ${resource.label}` : resource.label,
    actionLabel: onResource ? `${label}: ${resource.label}` : undefined,
  });
  chip.setAttribute("class", `ds-resource-chip activity-resource${onResource ? "" : " readonly"}`);
  chip.setAttribute("data-focus-key", `resource:${resource.raw}`);
  if (primary) chip.setAttribute("data-primary-resource", "true");
  return chip;
}
function contributorChips(activity, onFilter, filters = {}, limit = 3, onOpen) {
  const agents = activity.agents || [];
  return agents.length ? h("div", { class: "activity-contributors", "aria-label": "Contributors" }, agents.slice(0, limit).map(agent => agentChip(agent, onFilter, filters.agent)),
    agents.length > limit && (onOpen ? button(`+${agents.length - limit}`, () => onOpen(activity), { class: "activity-more-agents", "aria-label": `View all ${agents.length} contributors` }) : h("span", { class: "activity-more-agents" }, `+${agents.length - limit}`))) : null;
}
function reportLead(lead, className = "") {
  return lead && h("div", { class: `activity-report ${className}` }, h("span", { class: "activity-report-label" }, lead.label), h("p", {}, lead.text));
}
function rowMark(activity, tools, onFilter) {
  const agents = activity.agents || [], lead = agents[0];
  const label = lead ? contributorName(lead) : toolVisual(tools[0]).label;
  const mark = lead ? agentAvatar(lead.name, { ...lead, size: "row", working: lead.workingActions > 0 }) : h("span", { class: "activity-tool-mark" }, visualIcon(toolVisual(tools[0]), { size: 18 }));
  return h("div", { class: "activity-row-mark" },
    lead && onFilter ? button(mark, () => onFilter("agent", lead.name), { class: "activity-mark-button", title: lead.name, "aria-label": `Filter activity by ${label}`, "data-focus-key": `mark:${lead.name}` }) : mark,
    agents.length > 1 ? h("span", { class: "activity-mark-count", title: agents.map(contributorName).join(", "), "aria-label": `${agents.length} contributors` }, `+${agents.length - 1}`)
      : tools[0] && h("span", { class: "activity-mark-tool", title: tools[0], "aria-hidden": "true" }, visualIcon(toolVisual(tools[0]), { size: 10 })));
}
export function activityCard(activity, { onOpen, onFilter, onResource, filters = {} } = {}) {
  const presentation = activityPresentation(activity), seen = new Set();
  const tools = (activity.tools || []).filter(tool => { const visual = toolVisual(tool), key = `${visual.brand || visual.icon}:${visual.label}`; if (seen.has(key)) return false; seen.add(key); return true; });
  const agents = activity.agents || [], memory = presentation.kind === "memory";
  const context = !memory && presentation.lead;
  return h("article", { class: `activity-card activity-row ds-card activity-${presentation.kind}${activity.status === "running" ? " is-running" : ""}${context ? " has-context" : ""}`, "data-activity-id": activity.id },
    rowMark(activity, tools, onFilter),
    h("div", { class: "activity-row-main" },
      button([h("span", { class: "activity-title" }, presentation.title), icon("chevron-right", { size: 13, class: "activity-open-arrow" })], () => onOpen?.(activity),
        { class: "activity-open", "data-open-activity": activity.id, "data-focus-key": `open:${activity.id}`, "aria-label": `Open ${memory ? "memory operation" : presentation.kind}: ${presentation.title}` }),
      context && h("p", { class: "activity-row-context" }, h("span", { class: "activity-context-label" }, `${context.label} · `), context.text),
      h("div", { class: "activity-row-meta" },
        agents.length > 0 && h("div", { class: "activity-row-contributors", "aria-label": "Contributors" }, agents.slice(0, 2).map(agent => agentChip(agent, onFilter, filters.agent, { avatar: false })), agents.length > 2 && button(`+${agents.length - 2}`, () => onOpen?.(activity), { class: "activity-more-agents", "aria-label": `View all ${agents.length} contributors` })),
        presentation.memoryContext?.query && h("span", { class: "activity-row-query", title: presentation.memoryContext.query }, `“${presentation.memoryContext.query}”`),
        presentation.primaryResource && (!memory || !presentation.memoryContext?.query) && resourceControl(presentation.primaryResource, activity, onResource, { concise: presentation.title.includes(`“${presentation.primaryResource.label}”`) }),
        tools.length > 0 && h("div", { class: "activity-tools", "aria-label": "Tools used" }, tools.slice(0, memory ? 1 : 2).map(tool => toolChip(tool, onFilter || (() => {}), filters.tool === tool)), tools.length > (memory ? 1 : 2) && h("span", { class: "activity-tool-overflow" }, `+${tools.length - (memory ? 1 : 2)}`)),
        activity.actionCount > 1 && h("span", { class: "activity-step-count" }, plural(activity.actionCount, "step")),
        h("span", { class: "activity-evidence", title: presentation.evidence }, activity.evidence === "observed" ? "Observed" : activity.evidence === "mixed" ? "Mixed evidence" : "Reported"))),
    h("div", { class: "activity-row-aside" }, activityStatus(activity, { compact: true }), h("time", { datetime: activity.updatedAt, title: exactTime(activity.updatedAt), "data-relative-time": activity.updatedAt }, relativeTime(activity.updatedAt))));
}
export function activityFeed(activities, options = {}) {
  const items = [];
  let previous = "";
  for (const activity of activities) {
    const label = dateLabel(activity.updatedAt);
    if (label !== previous) items.push(h("div", { class: "activity-section-title" }, h("h2", {}, label)));
    previous = label;
    items.push(activityCard(activity, options));
  }
  return h("div", { class: "activity-feed", "aria-label": "Activity. Use up and down arrow keys to move between activities.", onkeydown: event => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) || !event.target.matches("[data-open-activity]")) return;
    const cards = [...event.currentTarget.querySelectorAll("[data-open-activity]")];
    const current = cards.indexOf(event.target);
    const next = event.key === "Home" ? 0 : event.key === "End" ? cards.length - 1 : Math.max(0, Math.min(cards.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
    event.preventDefault(); cards[next]?.focus();
  } }, items);
}
function receipt(action, key) {
  const rows = [["Agent", action.agent], ["Tool", action.tool], ["Evidence", action.evidence === "observed" ? "Observed by Engram" : "Agent-reported"],
    ["Status", action.status], ["Resource", action.resource], ["Run", action.runId], ["Action key", action.actionKey], ["Report ID", action.id],
    ["Started", exactTime(action.startedAt || action.occurredAt)], ["Received", exactTime(action.recordedAt)]];
  return h("details", { class: "work-log-details", "data-disclosure-key": `receipt:${key}` },
    h("summary", { "data-focus-key": `receipt:${key}` }, "Technical receipt", icon("chevron-down", { size: 12 })),
    h("dl", { class: "activity-receipt-fields" }, rows.filter(([, value]) => value).map(([label, value]) => [h("dt", {}, label), h("dd", {}, value)])),
    action.detail && h("pre", { class: "activity-receipt-detail" }, action.detail));
}
function actionEntry(action, activity, onResource) {
  const presentation = actionPresentation(action);
  const startedAt = action.startedAt || action.occurredAt;
  const key = JSON.stringify([action.agent, action.actionKey || action.id]);
  const stale = action.status === "running" && (!validDate(action.recordedAt) || Date.now() - new Date(action.recordedAt).valueOf() >= 900_000);
  const resource = resourcePresentation(action.resource, { memory: presentation.memory, tool: action.tool }) || presentation.memoryContext?.target;
  const agent = (activity.agents || []).find(agent => agent.name === action.agent) || { name: action.agent };
  return h("li", { class: `work-log-step ${action.status}${stale ? " stale" : ""}`, "data-log-key": key, "data-action-id": action.id },
    h("div", { class: "work-log-marker", "aria-hidden": "true" }, icon(stale ? "clock" : action.status === "running" ? "loader-circle" : action.status === "failed" ? "x" : "check", { size: 13, class: action.status === "running" && !stale ? "working-spinner" : "" })),
    h("div", { class: "work-log-content" },
      h("div", { class: "work-log-meta" }, h("span", { class: "work-log-agent", title: action.agent }, agentAvatar(action.agent, agent), contributorName(agent)),
        h("span", { class: "work-log-meta-end" }, h("span", { class: "work-log-state" }, stale ? "Awaiting update" : { running: "In progress", failed: "Failed", completed: "Completed" }[action.status] || "Unknown"), h("time", { datetime: startedAt, title: exactTime(startedAt) }, clockTime(startedAt)))),
      h("h4", {}, presentation.title),
      presentation.outcome && h("p", { class: "work-log-result" }, presentation.outcome),
      action.status !== "completed" && presentation.currentStep && presentation.currentStep !== presentation.outcome && h("p", { class: "work-log-current" }, presentation.currentStep),
      resource && resourceControl(resource, activity, onResource, { action }),
      receipt(action, key)));
}
export function activityLog(activity, { onResource } = {}) {
  const actions = chronologicalActions(activity.actions || []);
  return h("section", { class: "activity-work-log", "aria-label": "Chronological steps" },
    h("div", { class: "activity-log-heading" }, h("h3", {}, "Steps"), h("span", {}, "Oldest first")),
    h("ol", { class: "work-log-list" }, actions.map(action => actionEntry(action, activity, onResource))),
    actions.length > 1 && h("p", { class: "work-log-note" }, "Each step shows its latest recorded state. Updates to the same action stay together."));
}
export function activityDetail(activity, { onResource, expandSteps = false } = {}) {
  const presentation = activityPresentation(activity);
  const compact = presentation.kind === "memory" && presentation.actions.length <= 1;
  const lead = presentation.lead;
  return h("div", { class: `activity-overview activity-detail-content${compact ? " is-compact-operation" : ""}` },
    reportLead(lead, "activity-detail-report"),
    compact && !lead && presentation.memoryContext && reportLead({ label: "Operation", text: presentation.memoryContext.explanation }, "activity-detail-report"),
    presentation.memoryContext?.query && h("p", { class: "activity-last-step" }, h("span", {}, "Query"), h("q", {}, presentation.memoryContext.query)),
    activity.status !== "completed" && presentation.outcome && presentation.currentStep && presentation.outcome !== presentation.currentStep
      && h("p", { class: "activity-last-step" }, h("span", {}, lead?.text === presentation.currentStep ? "Reported outcome" : "Last reported step"), lead?.text === presentation.currentStep ? presentation.outcome : presentation.currentStep),
    presentation.resources.length > 0 && h("section", { class: "activity-detail-resources", "aria-label": "Resources" },
      presentation.resources.map(resource => resourceControl(resource, activity, onResource, { primary: resource === presentation.primaryResource }))),
    presentation.approaches.length > 0 && h("section", { class: "activity-detail-section" },
      h("div", { class: "activity-section-heading" }, h("h3", {}, "Method"), h("span", {}, presentation.approaches.every(approach => approach.evidence === "observed") ? "Recorded" : "Agent-reported")),
      h("div", { class: "activity-approaches" }, presentation.approaches.map(approach => {
        const agent = (activity.agents || []).find(agent => agent.name === approach.agent) || { name: approach.agent };
        return h("div", { class: "approach-card" }, h("div", { class: "approach-author", title: approach.agent }, agentAvatar(approach.agent, agent), h("span", {}, contributorName(agent))), h("p", {}, approach.text));
      }))),
    compact && presentation.actions[0] ? h("div", { class: "activity-compact-receipt", "data-action-id": presentation.actions[0].id, "data-log-key": JSON.stringify([presentation.actions[0].agent, presentation.actions[0].actionKey || presentation.actions[0].id]) },
      receipt(presentation.actions[0], JSON.stringify([presentation.actions[0].agent, presentation.actions[0].actionKey || presentation.actions[0].id])))
      : presentation.actions.length > 0 && h("details", { class: "activity-steps-expander", open: expandSteps, "data-disclosure-key": `steps:${activity.id}`, "data-focus-key": `section:steps:${activity.id}` },
        h("summary", { "data-focus-key": `steps:${activity.id}` }, icon("workflow", { size: 14 }), h("span", {}, plural(presentation.actions.length, "step")), h("span", { class: "activity-steps-caption" }, "Chronological"), icon("chevron-down", { size: 14 })),
        activityLog(activity, { onResource })),
    h("div", { class: "activity-source-note" }, icon("info", { size: 13 }), h("p", {},
      presentation.evidence, ". ", activity.evidence === "observed" ? "Engram recorded this operation on its own service." : "External actions, outcomes and methods come from agent reports.")));
}
// Compatibility for callers while the drawer moves to a single content view.
export const activityOverview = activityDetail;
export function activityDetailHeader(activity, { onFilter } = {}) {
  const presentation = activityPresentation(activity);
  return h("div", { class: "activity-detail-intro" },
    h("div", { class: "activity-detail-eyebrow" }, activityStatus(activity), h("span", {}, { task: "Task", action: "Action", memory: "Memory operation" }[presentation.kind])),
    h("div", { class: "activity-detail-heading" }, h("h2", { id: "detail-title" }, presentation.title), contributorChips(activity, onFilter, {}, Number.MAX_SAFE_INTEGER)),
    h("div", { class: "activity-detail-meta" }, h("span", {}, icon("clock", { size: 13 }), "Updated ", h("time", { datetime: activity.updatedAt, "data-relative-time": activity.updatedAt, "data-lowercase": "true" }, relativeTime(activity.updatedAt).toLowerCase())),
      activity.actionCount > 1 && h("span", {}, plural(activity.actionCount, "step"))),
    activity.staleActions > 0 && h("p", { class: "activity-stale-note" }, icon("clock", { size: 13 }), "A running report has not been updated in 15 minutes. Its current state is unknown."));
}
export function refreshActivityTimes(scope = document) {
  for (const node of scope.querySelectorAll("[data-relative-time]")) {
    const text = relativeTime(node.dataset.relativeTime);
    node.textContent = node.dataset.lowercase ? text.toLowerCase() : text;
  }
}
export function activitySkeleton() {
  return h("div", { class: "activity-skeleton", role: "status", "aria-label": "Loading activities" },
    [0, 1, 2].map(() => h("div", { class: "activity-card skeleton-card" }, h("div", { class: "skeleton-card-top" }, h("span", { class: "skeleton-line skeleton-square" }), h("div", {}, h("span", { class: "skeleton-line" }), h("span", { class: "skeleton-line short" }))), h("div", { class: "skeleton-card-bottom" }, h("span", { class: "skeleton-line" }), h("span", { class: "skeleton-line" })))));
}
