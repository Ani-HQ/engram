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
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
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
  plans: () => request("/api/plans"),
  signupPolicy: () => request("/api/signup-policy", { cache: "no-store", signal: AbortSignal.timeout(10000) }),
  signupInvites: workspaceId => request("/api/admin/signup-invites", scoped(workspaceId)),
  issueSignupInvite: (payload, workspaceId) => post("/api/admin/signup-invites", payload, workspaceId),
  revokeSignupInvite: (id, workspaceId) => post(`/api/admin/signup-invites/${encodeURIComponent(id)}/revoke`, {}, workspaceId),
  billing: workspaceId => request("/api/billing", scoped(workspaceId)),
  checkout: (plan, workspaceId) => post("/api/billing/checkout", { plan }, workspaceId),
  billingPortal: workspaceId => post("/api/billing/portal", {}, workspaceId),
  members: workspaceId => request("/api/members", scoped(workspaceId)),
  invite: (email, workspaceId) => post("/api/invites", { email, role: "member" }, workspaceId),
  removeMember: (email, workspaceId) => request("/api/members", { ...scoped(workspaceId), method: "DELETE", body: JSON.stringify({ email }) }),
  savePolicies: (policies, workspaceId) => request("/api/policies", { ...scoped(workspaceId), method: "PUT", body: JSON.stringify({ policies }) }),
  setTokenWrite: (name, canWrite, workspaceId) => post("/api/tokens/write", { name, canWrite }, workspaceId),
  setTokenSource: (payload, workspaceId) => post("/api/tokens/source", payload, workspaceId),
  showcase: workspaceId => request("/api/showcase", scoped(workspaceId)),
  saveShowcase: (profile, workspaceId) => request("/api/showcase", { ...scoped(workspaceId), method: "PUT", body: JSON.stringify(profile) }),
  me: () => request("/api/me"),
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
  wiring: workspaceId => request("/api/wiring", scoped(workspaceId)),
  mintToken: (payload, workspaceId) => post("/api/tokens", payload, workspaceId),
  revokeToken: (name, workspaceId) => post("/api/tokens/revoke", { name }, workspaceId),
  insights: (params, workspaceId) => request(query("/api/insights", params), scoped(workspaceId)),
  runInsights: (payload, workspaceId) => post("/api/insights", payload, workspaceId),
  reviews: (params, workspaceId) => request(query("/api/review", params), scoped(workspaceId)),
  review: (id, workspaceId) => request(query("/api/review/item", { id }), scoped(workspaceId)),
  resolveReview: (id, action, workspaceId) => post(`/api/review/${action}`, { id }, workspaceId),
};

// Callbacks retain the workspace that created them, even if the session cookie
// changes before a request reaches the server. The server verifies this header.
export function workspaceApi(workspaceId) {
  const methods = ["signupInvites", "issueSignupInvite", "revokeSignupInvite", "provisioning", "onboarding", "billing", "checkout", "billingPortal", "members", "invite", "removeMember", "savePolicies", "setTokenWrite", "setTokenSource", "showcase", "saveShowcase", "actions", "activities", "activity", "pages", "search", "page", "capture", "tokens", "connections", "wiring", "mintToken", "revokeToken", "insights", "runInsights", "reviews", "review", "resolveReview"];
  return Object.fromEntries(methods.map(name => [name, (...args) => api[name](...args, workspaceId)]));
}
