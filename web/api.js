const HEADER = "X-Engram-Console";

export class AuthError extends Error {
  constructor() { super("Please sign in again."); this.name = "AuthError"; }
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set(HEADER, "1");
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  if (response.status === 401) throw new AuthError();
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || `Request failed (${response.status}).`); error.status = response.status; error.code = data.code; throw error; }
  return data;
}

function query(path, params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== "" && value !== undefined && value !== null) search.set(key, String(value));
  });
  return `${path}${search.size ? `?${search}` : ""}`;
}
const scoped = workspaceId => ({ headers: workspaceId ? { "X-Engram-Workspace": String(workspaceId) } : {} });
const post = (path, body, workspaceId) => request(path, { ...scoped(workspaceId), method: "POST", body: JSON.stringify(body) });

export const api = {
  sharing: workspaceId => request("/api/sharing", { ...scoped(workspaceId), cache: "no-store" }),
  receivedSharing: (params, workspaceId) => request(query("/api/sharing", params), { ...scoped(workspaceId), cache: "no-store", signal: AbortSignal.timeout(10000) }),
  sharingPreview: (payload, workspaceId) => post("/api/sharing/preview", payload, workspaceId),
  sharingCommit: (payload, workspaceId) => post("/api/sharing/commit", payload, workspaceId),
  revokeSharing: (id, workspaceId) => request(`/api/sharing/${encodeURIComponent(id)}`, { ...scoped(workspaceId), method: "DELETE" }),
  rotateSharingToken: (id, workspaceId) => post(`/api/sharing/${encodeURIComponent(id)}/agent-token`, {}, workspaceId),
  plans: () => request("/api/plans"),
  signupPolicy: () => request("/api/signup-policy", { cache: "no-store", signal: AbortSignal.timeout(10000) }),
  signupInvites: workspaceId => request("/api/admin/signup-invites", scoped(workspaceId)),
  issueSignupInvite: (payload, workspaceId) => post("/api/admin/signup-invites", payload, workspaceId),
  signupInviteLink: (id, workspaceId) => request(`/api/admin/signup-invites/${encodeURIComponent(id)}/link`, { ...scoped(workspaceId), method: "POST", body: "{}", cache: "no-store" }),
  revokeSignupInvite: (id, workspaceId) => post(`/api/admin/signup-invites/${encodeURIComponent(id)}/revoke`, {}, workspaceId),
  billing: workspaceId => request("/api/billing", scoped(workspaceId)),
  jev: workspaceId => request("/api/jev", { ...scoped(workspaceId), cache: "no-store" }),
  saveJev: (settings, workspaceId) => request("/api/jev", { ...scoped(workspaceId), method: "PUT", body: JSON.stringify(settings) }),
  checkout: (plan, workspaceId) => post("/api/billing/checkout", { plan }, workspaceId),
  billingPortal: workspaceId => post("/api/billing/portal", {}, workspaceId),
  members: workspaceId => request("/api/members", scoped(workspaceId)),
  renameWorkspace: (name, workspaceId) => request("/api/workspace", { ...scoped(workspaceId), method: "PUT", body: JSON.stringify({ name }) }),
  invite: (email, workspaceId) => post("/api/invites", { email, role: "member" }, workspaceId),
  removeMember: (email, workspaceId) => request("/api/members", { ...scoped(workspaceId), method: "DELETE", body: JSON.stringify({ email }) }),
  savePolicies: (policies, workspaceId) => request("/api/policies", { ...scoped(workspaceId), method: "PUT", body: JSON.stringify({ policies }) }),
  setTokenWrite: (name, canWrite, workspaceId) => post("/api/tokens/write", { name, canWrite }, workspaceId),
  setTokenSource: (payload, workspaceId) => post("/api/tokens/source", payload, workspaceId),
  showcase: workspaceId => request("/api/showcase", scoped(workspaceId)),
  saveShowcase: (profile, workspaceId) => request("/api/showcase", { ...scoped(workspaceId), method: "PUT", body: JSON.stringify(profile) }),
  me: workspaceId => request("/api/me", { ...scoped(workspaceId), cache: "no-store" }),
  provisioning: workspaceId => request("/api/provisioning", scoped(workspaceId)),
  onboarding: workspaceId => request("/api/onboarding", { ...scoped(workspaceId), signal: AbortSignal.timeout(10000) }),
  login: token => post("/api/session", { token }),
  logout: () => request("/api/session", { method: "DELETE" }),
  loginEmail: email => post("/api/login/email", { email }),
  createOrg: payload => post("/api/orgs", payload),
  acceptInvite: token => post("/api/invites/accept", { token }),
  switchOrg: orgId => post("/api/session/switch", { orgId }),
  actions: (params, workspaceId) => request(query("/api/actions", params), { headers: workspaceId ? { "X-Engram-Workspace": String(workspaceId) } : {} }),
  activities: (params, workspaceId) => request(query("/api/activities", params), { headers: workspaceId ? { "X-Engram-Workspace": String(workspaceId) } : {} }),
  activity: (id, workspaceId) => request(`/api/activities/${encodeURIComponent(id)}`, { headers: workspaceId ? { "X-Engram-Workspace": String(workspaceId) } : {} }),
  pages: (params, workspaceId) => request(query("/api/pages", params), { headers: workspaceId ? { "X-Engram-Workspace": String(workspaceId) } : {} }),
  search: (params, workspaceId) => request(query("/api/search", params), scoped(workspaceId)),
  page: (slug, workspaceId) => request(query("/api/page", { slug }), { headers: workspaceId ? { "X-Engram-Workspace": String(workspaceId) } : {} }),
  capture: (payload, workspaceId) => post("/api/capture", payload, workspaceId),
  tokens: workspaceId => request("/api/tokens", scoped(workspaceId)),
  connections: workspaceId => request("/api/connections", { ...scoped(workspaceId), signal: AbortSignal.timeout(5000) }),
  manageConnection: (id, action, workspaceId) => post("/api/connections", { id, action }, workspaceId),
  saveAgentIdentity: (body, workspaceId) => post("/api/agent-identities", body, workspaceId),
  wiring: workspaceId => request("/api/wiring", scoped(workspaceId)),
  mintToken: (payload, workspaceId) => post("/api/tokens", payload, workspaceId),
  device: (code, workspaceId) => request(query("/api/device", { code }), { ...scoped(workspaceId), cache: "no-store" }),
  approveDevice: (userCode, workspaceId) => post("/api/device/approve", { userCode }, workspaceId),
  denyDevice: (userCode, workspaceId) => post("/api/device/deny", { userCode }, workspaceId),
  revokeToken: (name, workspaceId) => post("/api/tokens/revoke", { name }, workspaceId),
  insights: (params, workspaceId) => request(query("/api/insights", params), scoped(workspaceId)),
  runInsights: (payload, workspaceId) => post("/api/insights", payload, workspaceId),
  reviews: (params, workspaceId) => request(query("/api/review", params), scoped(workspaceId)),
  review: (id, workspaceId) => request(query("/api/review/item", { id }), scoped(workspaceId)),
  resolveReview: (id, action, workspaceId) => post(`/api/review/${action}`, { id }, workspaceId),
  tasks: (params, workspaceId) => request(query("/api/tasks", params), { ...scoped(workspaceId), cache: "no-store" }),
  task: (id, workspaceId) => request(`/api/tasks/${encodeURIComponent(id)}`, { ...scoped(workspaceId), cache: "no-store" }),
  exportTasks: (params, workspaceId) => request(query("/api/tasks/export", params), { ...scoped(workspaceId), cache: "no-store" }),
  closeTask: (id, workspaceId) => post(`/api/tasks/${encodeURIComponent(id)}/close`, {}, workspaceId),
  reopenTask: (id, workspaceId) => post(`/api/tasks/${encodeURIComponent(id)}/reopen`, {}, workspaceId),
  deleteTask: (id, workspaceId) => request(`/api/tasks/${encodeURIComponent(id)}`, { ...scoped(workspaceId), method: "DELETE" }),
  restoreTask: (id, workspaceId) => post(`/api/tasks/${encodeURIComponent(id)}/restore`, {}, workspaceId),
};

// Callbacks retain the workspace that created them, even if the session cookie
// changes before a request reaches the server. The server verifies this header.
export function workspaceApi(workspaceId) {
  const methods = ["sharing", "sharingPreview", "sharingCommit", "revokeSharing", "rotateSharingToken", "jev", "saveJev", "renameWorkspace", "signupInvites", "issueSignupInvite", "signupInviteLink", "revokeSignupInvite", "provisioning", "onboarding", "billing", "checkout", "billingPortal", "members", "invite", "removeMember", "savePolicies", "setTokenWrite", "setTokenSource", "showcase", "saveShowcase", "actions", "activities", "activity", "pages", "search", "page", "capture", "tokens", "connections", "wiring", "mintToken", "revokeToken", "device", "approveDevice", "denyDevice", "insights", "runInsights", "reviews", "review", "resolveReview", "tasks", "task", "exportTasks", "closeTask", "reopenTask", "deleteTask", "restoreTask"];
  return Object.fromEntries([...methods, "manageConnection", "saveAgentIdentity", "receivedSharing"].map(name => [name, (...args) => api[name](...args, workspaceId)]));
}
