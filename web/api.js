const CONSOLE_HEADER = "X-Engram-Console";

export class AuthError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "AuthError";
  }
}

async function request(path, options = {}) {
  const method = options.method ?? "GET";
  const headers = new Headers(options.headers ?? {});
  // Sent on EVERY call, session included: a custom header always forces a preflight
  // the gateway never answers, so a hostile origin cannot mint a cookie here either.
  headers.set(CONSOLE_HEADER, "1");
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(path, {
    ...options,
    method,
    headers,
    credentials: "same-origin",
  });

  if (res.status === 401) throw new AuthError();
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `request failed: ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

function query(path, params) {
  const url = new URL(path, location.origin);
  Object.entries(params ?? {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  return `${url.pathname}${url.search}`;
}

export const api = {
  login(token) {
    return request("/api/session", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  },
  logout() {
    return request("/api/session", { method: "DELETE" });
  },
  me() {
    return request("/api/me");
  },
  pages(params = {}) {
    return request(query("/api/pages", {
      limit: params.limit ?? 48,
      offset: params.offset ?? 0,
      sort: params.sort ?? "updated_desc",
      tag: params.tag,
      scope: params.scope,
    }));
  },
  search(params = {}) {
    return request(query("/api/search", {
      q: params.q,
      limit: params.limit ?? 48,
      scope: params.scope,
    }));
  },
  page(params) {
    return request(query("/api/page", params));
  },
  capture(payload) {
    return request("/api/capture", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
};
