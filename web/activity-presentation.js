// Display only recorded metadata. These helpers never infer a goal or an outcome.
const text = value => typeof value === "string" ? value.trim() : "";
const memoryTools = {
  remember: "Save memory", recall: "Search memory", search: "Search memory",
  get_page: "Read memory", list_pages: "Browse memory", put_page: "Save memory",
  add_tag: "Tag memory", add_link: "Link memories", add_timeline_entry: "Add a memory timeline entry",
};
function memoryTool(tool) {
  const name = text(tool).toLowerCase().replace(/^mcp__/, "").replaceAll("__", ".");
  const parts = name.split(/[.:/]/);
  const operation = parts.at(-1);
  return (parts.length === 1 || parts.slice(0, -1).every(part => ["engram", "gbrain", "memory"].includes(part)))
    && Object.hasOwn(memoryTools, operation) ? operation : null;
}
export function memoryToolLabel(tool) { return memoryTools[memoryTool(tool)] || null; }
/** Friendly connection labels never replace the authenticated identity. */
export function contributorName(agent) { return text(agent?.displayName) || text(agent?.name) || "Agent"; }
function words(value) {
  const name = text(value).replace(/\.(?:md|markdown)$/i, "").replace(/[_-]+/g, " ");
  return name ? name[0].toUpperCase() + name.slice(1) : "Resource";
}
function memorySlug(value) {
  let slug;
  try { slug = decodeURIComponent(value).replace(/^\/+|\/+$/g, ""); } catch { return null; }
  return slug && slug.length <= 500 && !/[\s:?#\\\u0000-\u001f\u007f]/.test(slug)
    && !slug.split("/").some(part => !part || part === "." || part === "..") ? slug : null;
}
/** A navigation descriptor, not a URL to assign blindly to an anchor. */
export function resourcePresentation(value, { memory = false } = {}) {
  const raw = text(value);
  if (!raw) return null;
  if (/^engram:\/\//i.test(raw)) {
    const slug = memorySlug(raw.slice("engram://".length));
    return slug ? { raw, kind: "memory", slug, href: null, label: words(slug.split("/").at(-1)) } : { raw, kind: "resource", slug: null, href: null, label: raw };
  }
  if (/^https?:\/\//i.test(raw) && !/[\u0000-\u0020\u007f\\]/.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.hostname && !url.username && !url.password) {
        let path = url.pathname === "/" ? "" : url.pathname;
        try { path = decodeURIComponent(path); } catch { /* Keep malformed escaping literal. */ }
        return { raw, kind: "url", slug: null, href: url.href, label: `${url.hostname}${path}` };
      }
    } catch { /* Opaque resource identifiers remain readable, never executable. */ }
  }
  const slug = memory && !raw.includes(":") ? memorySlug(raw) : null;
  return slug ? { raw, kind: "memory", slug, href: null, label: words(slug.split("/").at(-1)) }
    : { raw, kind: "resource", slug: null, href: null, label: raw };
}
function timestamp(value) { const result = Date.parse(value); return Number.isFinite(result) ? result : 0; }
export function chronologicalActions(actions = []) {
  return [...actions].sort((a, b) => timestamp(a.startedAt || a.occurredAt) - timestamp(b.startedAt || b.occurredAt)
    || timestamp(a.recordedAt) - timestamp(b.recordedAt) || text(a.id).localeCompare(text(b.id)));
}
function boundedArgument(value, maximum) {
  const result = text(value);
  return result && result.length <= maximum && !/[\u0000-\u001f\u007f]/.test(result) ? result : "";
}
/** Audit arguments may be truncated. Never repair them or inspect memory body fields. */
function memoryArguments(detail) {
  const source = text(detail);
  if (!source || source.length > 8192 || !source.startsWith("{")) return null;
  try {
    const value = JSON.parse(source);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}
export function memoryOperationContext(action) {
  const operation = memoryTool(action.tool);
  if (!operation) return null;
  const args = memoryArguments(action.detail);
  const query = ["recall", "search"].includes(operation) && args
    ? boundedArgument(args.query, 280) || boundedArgument(args.q, 280) : "";
  const supplied = resourcePresentation(action.resource, { memory: true });
  const argumentSlug = args ? memorySlug(boundedArgument(args.slug, 500)) : null;
  const target = supplied?.kind === "memory" ? supplied
    : argumentSlug ? resourcePresentation(`engram://${argumentSlug}`) : null;
  const request = { get_page: "memory read", recall: "memory search", search: "memory search", list_pages: "memory listing",
    remember: "memory save", put_page: "memory save", add_tag: "memory tagging", add_link: "memory linking", add_timeline_entry: "memory timeline" }[operation];
  const explanation = action.status === "completed" ? `The ${request} request completed.`
    : action.status === "failed" ? `The ${request} request failed.`
    : action.status === "running" ? `A ${request} request is in progress.` : `A ${request} request was recorded.`;
  return { operation, explanation, query, target };
}
function plainReport(value) {
  const source = text(value);
  if (!source || source.length > 4000 || /^[{["`<]/.test(source) || source.includes("```") || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source)) return "";
  // JSON scalar values are structured receipts too, not prose reports.
  try { JSON.parse(source); return ""; } catch { return source.length <= 800 ? source : `${source.slice(0, 799).trimEnd()}…`; }
}
function memoryTitle(operation, status, target) {
  const titles = {
    get_page: ["Read a memory", "Reading memory", "Could not read memory", "Memory read"],
    remember: ["Saved a memory", "Saving memory", "Could not save memory", "Memory save"],
    put_page: ["Saved a memory", "Saving memory", "Could not save memory", "Memory save"],
    recall: ["Searched memory", "Searching memory", "Could not search memory", "Memory search"],
    search: ["Searched memory", "Searching memory", "Could not search memory", "Memory search"],
    list_pages: ["Browsed memory", "Browsing memory", "Could not browse memory", "Memory listing"],
    add_tag: ["Tagged a memory", "Tagging memory", "Could not tag memory", "Memory tagging"],
    add_link: ["Linked memories", "Linking memories", "Could not link memories", "Memory linking"],
    add_timeline_entry: ["Updated a memory timeline", "Updating a memory timeline", "Could not update a memory timeline", "Memory timeline update"],
  };
  const verbs = { get_page: ["Read", "Reading", "Could not read"], remember: ["Saved", "Saving", "Could not save"],
    put_page: ["Saved", "Saving", "Could not save"], add_tag: ["Tagged", "Tagging", "Could not tag"],
    add_link: ["Linked", "Linking", "Could not link"], add_timeline_entry: ["Updated timeline for", "Updating timeline for", "Could not update timeline for"] };
  const index = { completed: 0, running: 1, failed: 2 }[status] ?? 3;
  return target && verbs[operation] && index < 3 ? `${verbs[operation][index]} “${target.label}”` : titles[operation]?.[index] || null;
}
export function actionPresentation(action) {
  const summary = text(action.summary);
  const operation = memoryTool(action.tool);
  const plain = summary.toLowerCase().replace(/\s*\((?:error|denied|ok|failed)\)$/, "").replace(/[_-]+/g, " ");
  const generic = operation && [operation.replaceAll("_", " "), text(action.tool).toLowerCase()].includes(plain);
  const context = memoryOperationContext(action);
  const targeted = memoryTitle(operation, action.status, context?.target);
  return { title: text(action.taskTitle) || (generic ? targeted : summary) || targeted || "Recorded action",
    outcome: text(action.outcome), currentStep: text(action.currentStep), memory: Boolean(operation), memoryContext: context };
}
export function activityPresentation(activity) {
  const actions = chronologicalActions(activity.actions || []);
  const tools = [...new Set([...(activity.tools || []), ...actions.map(action => action.tool)].map(text).filter(Boolean))];
  const kind = ["task", "action", "memory"].includes(activity.kind) ? activity.kind
    : (text(activity.taskTitle) || activity.runId) ? "task"
    : activity.evidence === "observed" && tools.length && tools.every(memoryTool) ? "memory" : "action";
  const single = actions.length === 1 ? actions[0] : null;
  const uniqueResources = [...new Set([activity.resource, ...(activity.resources || []), ...actions.map(action => action.resource)].map(text).filter(Boolean))];
  const contextAction = { ...activity, tool: tools[0], detail: activity.detail || single?.detail,
    resource: activity.resource || (uniqueResources.length === 1 ? uniqueResources[0] : null) };
  const context = kind === "memory" ? memoryOperationContext(contextAction) : null;
  const title = actionPresentation(contextAction).title;
  const outcome = text(activity.outcome), currentStep = text(activity.currentStep);
  const latestReport = kind !== "memory" && !outcome ? [...actions]
    .sort((a, b) => timestamp(b.recordedAt || b.occurredAt) - timestamp(a.recordedAt || a.occurredAt))
    .filter(action => action.evidence === "reported" && !memoryTool(action.tool))
    .map(action => plainReport(action.detail)).find(value => value && value !== title && value !== currentStep) || "" : "";
  const lead = activity.status === "running" && currentStep ? { label: "Current step", text: currentStep }
    : outcome ? { label: "Outcome", text: outcome } : latestReport ? { label: "Latest report", text: latestReport }
    : currentStep ? { label: "Last reported step", text: currentStep } : null;
  const values = [...new Set([...uniqueResources, context?.target?.raw].filter(Boolean))];
  const resources = values.map(value => resourcePresentation(value, { memory: kind === "memory" }));
  const explicitResource = text(activity.resource);
  return { kind, title, outcome, currentStep, lead, resources, actions, memoryContext: context, latestReport,
    primaryResource: explicitResource ? resources.find(resource => resource.raw === explicitResource) : resources.length === 1 ? resources[0] : null,
    approaches: (activity.approaches || []).filter(approach => text(approach.text)).map(approach => ({ ...approach, text: text(approach.text) })),
    evidence: activity.evidence === "observed" ? "Observed by Engram" : activity.evidence === "mixed" ? "Observed and reported" : "Agent-reported" };
}
