import { describe, expect, test, setSystemTime } from "bun:test";
import postgres from "postgres";
import { getPublicActivity, getShowcaseSettings, handlePublicShowcase, handleShowcaseApi, parseShowcaseInput, publicActivitySnapshot, renderShowcaseCard, renderShowcasePage, renderShowcasePng, showcaseCategory, updateShowcaseSettings, SHOWCASE_PAYLOAD_LIMIT, type ShowcaseProfile } from "../gateway/src/showcase";
import { runWithContext } from "../gateway/src/context";
import { DEFAULT_POLICIES, normalizeToken } from "../gateway/src/policies";

const owner = normalizeToken({ name: "private-owner@example.com", role: "owner", orgId: 7 });
const now = new Date("2026-10-22T00:03:00Z");
const profile: ShowcaseProfile = { slug: "my-agents", displayName: "Ada", bio: "Building with agents", published: true, showActivity: false, layout: "studio", highlights: [] };
// Use the driver's real typed JSON helper without executing a connection.
const jsonParameter = postgres().json;
const aggregate = {
  total_actions: "17", completed_actions: "13", failed_actions: "2", running_actions: "2",
  active_agents: "3", active_days: "4", updated_at: "2026-10-21T21:00:00Z",
  working_agents: "1", recently_active_agents: "2", completed_agents: "3", failed_agents: "1", working_actions: "1", stale_actions: "1", last_activity_at: "2026-10-22T00:02:00Z",
  daily: [{ date: "2026-10-21", count: "8" }, { date: "2026-10-22", count: 2 }],
  tools: [{ category: "code", count: "10" }, { category: "email", count: "7" }],
  summary: "private task text", agent: "private-agent-name", resource: "https://private.example.com", run_id: "secret-run-id", approach: "private-method-secret",
};

function database(initial: ShowcaseProfile | null = profile) {
  const profiles = new Map<number, ShowcaseProfile>();
  if (initial) profiles.set(7, { ...initial });
  const calls: { query: string; values: any[] }[] = [];
  let unavailable = false;
  let aggregateHook: (() => void) | undefined;
  let eventRows: any[] = [];
  function execute(query: string, values: any[]) {
    calls.push({ query, values });
    if (unavailable) throw new Error("private connection details");
    if (query.includes("INSERT INTO action_profiles")) {
      if ([...profiles].some(([id, value]) => id !== values[0] && value.slug === values[1])) throw Object.assign(new Error("duplicate"), { code: "23505" });
      const highlights = values[7];
      // A JSON-encoded string can be serialized again when PostgreSQL infers
      // jsonb. Require the typed array binding that the real constraint accepts.
      if (highlights?.type !== 3802 || !Array.isArray(highlights.value)) throw Object.assign(new Error("highlights must be a JSON array"), { code: "23514" });
      const existing = profiles.get(values[0]);
      const saved = { slug: values[1], displayName: values[2], bio: values[3], published: values[4], showActivity: values[5] === true, layout: existing && !values[8] ? existing.layout : values[6], highlights: existing && !values[9] ? existing.highlights : structuredClone(highlights.value) };
      profiles.set(values[0], saved);
      return [{ slug: saved.slug, display_name: saved.displayName, bio: saved.bio, published: saved.published, show_activity: saved.showActivity, layout: saved.layout, highlights: saved.highlights }];
    }
    if (query.includes("FROM action_profiles")) {
      const entry = query.includes("published = true")
        ? [...profiles].find(([, value]) => value.slug === values[0] && value.published)
        : [...profiles].find(([id]) => id === values[0]);
      if (!entry) return [];
      const [orgId, value] = entry;
      return [{ org_id: orgId, slug: value.slug, display_name: value.displayName, bio: value.bio, published: value.published, show_activity: value.showActivity === true, layout: value.layout, highlights: value.highlights, email: "private@example.com" }];
    }
    if (query.includes("WITH latest_reports")) return eventRows;
    if (query.includes("WITH ledger")) { aggregateHook?.(); return [aggregate]; }
    throw new Error("Unexpected test query");
  }
  const db = ((strings: TemplateStringsArray, ...parameters: any[]) => {
    // Match postgres.js's lazy nested SQL fragments: only the final awaited
    // aggregate executes, and each tenant binding remains visible to the test.
    let query = strings[0]; const values: any[] = [];
    parameters.forEach((value, index) => {
      if (value?.fragment === true) { query += value.query; values.push(...value.values); }
      else { query += "?"; values.push(value); }
      query += strings[index + 1];
    });
    return { fragment: true, query, values, then(resolve: any, reject: any) { return Promise.resolve().then(() => execute(query, values)).then(resolve, reject); } };
  }) as unknown as postgres.Sql;
  db.json = jsonParameter;
  return { db, calls, profiles, events: (rows: any[]) => { eventRows = rows; }, fail: () => { unavailable = true; }, onAggregate: (callback: () => void) => { aggregateHook = callback; } };
}

describe("showcase control", () => {
  test("starts private with no implicit identity, but gives the owner an aggregate preview", async () => {
    const { db, calls } = database(null);
    const settings = await getShowcaseSettings(owner, "https://engram.example", db);
    expect(settings.profile).toEqual({ slug: "", displayName: "", bio: "", published: false, showActivity: false, layout: "studio", highlights: [] });
    expect(settings.urls).toEqual({ page: null, json: null, card: null, stream: null });
    expect(settings.preview.stats.totalActions).toBe(17);
    expect(calls[0].values).toEqual([7]);
    expect(calls[1].values.slice(0, 2)).toEqual([7, 7]);
    expect(JSON.stringify(settings)).not.toContain(owner.name);
  });

  test("validates the full profile, safe addresses, types and bounds before persistence", () => {
    for (const slug of ["a", "ab", "-abc", "abc-", "a--b", "ABC", "a/b", "a.b", "a b", "éabc", "a".repeat(49)]) {
      expect(() => parseShowcaseInput({ ...profile, slug })).toThrow();
    }
    for (const value of [null, [], {}, { ...profile, published: "true" }, { ...profile, showActivity: "true" }, { ...profile, showActivity: null }, { ...profile, showActivity: 1 }, { ...profile, orgId: 99 }, { ...profile, displayName: "x".repeat(81) }, { ...profile, bio: "x".repeat(161) }]) {
      expect(() => parseShowcaseInput(value)).toThrow();
    }
    expect(parseShowcaseInput({ ...profile, displayName: " Ada ", bio: " Hello " })).toMatchObject({ displayName: "Ada", bio: "Hello" });
    expect(parseShowcaseInput({ ...profile, slug: "a-1" }).slug).toBe("a-1");
  });

  test("allows only owners, honors token scopes and denies mismatched workspace contexts", async () => {
    const { db, calls } = database();
    for (const token of [normalizeToken({ ...owner, role: "agent" }), normalizeToken({ ...owner, role: "member" }), normalizeToken({ ...owner, kind: "oauth", scopes: ["memory:write-denied"] })]) {
      await expect(getShowcaseSettings(token, "https://engram.example", db)).rejects.toMatchObject({ status: 403 });
      await expect(updateShowcaseSettings(token, profile, "https://engram.example", db)).rejects.toMatchObject({ status: 403 });
    }
    await expect(updateShowcaseSettings(normalizeToken({ ...owner, canWrite: false }), profile, "https://engram.example", db)).rejects.toMatchObject({ status: 403 });
    await expect(updateShowcaseSettings(normalizeToken({ ...owner, kind: "oauth", scopes: ["memory:read"] }), profile, "https://engram.example", db)).rejects.toMatchObject({ status: 403 });
    await runWithContext({ org: { id: 8, name: "Other", slug: "other", kind: "team", brainDb: "brain_org_8", dataDb: "brain_org_8", homeDir: "other", policies: DEFAULT_POLICIES }, token: normalizeToken({ ...owner, orgId: 8 }), dataSql: db }, async () => {
      await expect(getShowcaseSettings(owner, "https://engram.example", db)).rejects.toMatchObject({ status: 403 });
    });
    expect(calls).toHaveLength(0);
  });

  test("persists only the current workspace and returns portfolio and PNG share URLs", async () => {
    const { db, calls } = database(null);
    const result = await updateShowcaseSettings(owner, profile, "https://engram.example/", db);
    expect(result.profile).toEqual(profile);
    expect(result.urls).toEqual({ page: "https://engram.example/u/my-agents", json: "https://engram.example/api/public/activity/my-agents", card: "https://engram.example/api/public/activity/my-agents/card.png", stream: "https://engram.example/api/public/activity/my-agents/stream" });
    expect(calls[0].query).toContain("ON CONFLICT (org_id)");
    expect(calls[0].values).toEqual([7, profile.slug, profile.displayName, profile.bio, true, false, "studio", expect.objectContaining({ type: 3802, value: [] }), true, true]);
    expect(result.preview.stats.totalActions).toBe(17);
    await expect(updateShowcaseSettings(normalizeToken({ ...owner, orgId: 8 }), profile, "https://engram.example", db)).rejects.toMatchObject({ status: 409 });
  });

  test("checks authorization before payload errors, limits input and contains storage failures", async () => {
    const store = database();
    const request = (body: string) => new Request("https://engram.example/api/showcase", { method: "PUT", body });
    expect((await handleShowcaseApi(request("not json"), normalizeToken({ ...owner, role: "agent" }), store.db)).status).toBe(403);
    expect((await handleShowcaseApi(request("not json"), owner, store.db)).status).toBe(400);
    expect((await handleShowcaseApi(request(" ".repeat(SHOWCASE_PAYLOAD_LIMIT + 1)), owner, store.db)).status).toBe(413);
    store.fail();
    const response = await handleShowcaseApi(new Request("https://engram.example/api/showcase"), owner, store.db);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private connection");
  });
});

describe("owner-written profile presentation", () => {
  const highlights = [{ title: "Release notes", body: "A short, deliberately public project update.", url: "https://example.com/releases" }];

  test("binds empty and populated highlights as typed JSON arrays without pre-encoding", async () => {
    for (const selected of [[], highlights]) {
      const store = database(null);
      const saved = await updateShowcaseSettings(owner, { ...profile, highlights: selected }, "https://engram.example", store.db);
      expect(store.calls[0].values[7]).toMatchObject({ type: 3802, value: selected });
      expect(Array.isArray(store.calls[0].values[7].value)).toBe(true);
      expect(store.profiles.get(owner.orgId)?.highlights).toEqual(selected);
      expect(saved.profile.highlights).toEqual(selected);
    }
  });

  test("validates bounded highlight records and safe optional links without accepting private record fields", () => {
    expect(parseShowcaseInput({ ...profile, layout: "field-notes", highlights: [{ title: "  A public note  ", body: "  Chosen by the owner.  ", url: "  https://example.com/note  " }, { title: "No link", body: "" }] })).toMatchObject({ layout: "field-notes", highlights: [{ title: "A public note", body: "Chosen by the owner.", url: "https://example.com/note" }, { title: "No link", body: "", url: "" }] });
    for (const layout of [null, "", "unknown", "STUDIO", [], 1]) expect(() => parseShowcaseInput({ ...profile, layout })).toThrow();
    for (const value of [null, {}, "text", [...highlights, ...highlights, ...highlights, ...highlights], [null], [[]], [{ ...highlights[0], privateSource: "memory/private" }], [{ ...highlights[0], title: " " }], [{ ...highlights[0], title: "x".repeat(81) }], [{ ...highlights[0], body: "x".repeat(601) }], [{ title: "Missing body" }], [{ ...highlights[0], url: null }], [{ ...highlights[0], url: "https://example.com/" + "x".repeat(2048) }]]) expect(() => parseShowcaseInput({ ...profile, highlights: value })).toThrow();
    for (const url of ["javascript:alert(1)", "data:text/html,hello", "file:///private/data", "//example.com", "/relative", "https:example.com", "https://user:password@example.com", "https://user@example.com", "https://example.com/\nprivate"]) expect(() => parseShowcaseInput({ ...profile, highlights: [{ ...highlights[0], url }] })).toThrow();
    expect(parseShowcaseInput({ ...profile, highlights: [{ title: "x".repeat(80), body: "x".repeat(600), url: "http://example.com" }, { title: "Optional", body: "", url: "   " }, highlights[0]] }).highlights).toHaveLength(3);
  });

  test("defaults old rows and preserves presentation on legacy updates while permitting explicit clearing", async () => {
    const legacy = { slug: profile.slug, displayName: profile.displayName, bio: profile.bio, published: true, showActivity: false };
    const old = database(legacy);
    expect((await getShowcaseSettings(owner, "https://engram.example", old.db)).profile).toEqual({ ...legacy, layout: "studio", highlights: [] });
    const store = database({ ...profile, layout: "field-notes", highlights });
    const saved = await updateShowcaseSettings(owner, { ...legacy, bio: "Updated by an old client" }, "https://engram.example", store.db);
    expect(saved.profile).toMatchObject({ layout: "field-notes", highlights });
    expect(saved.preview.profile).toMatchObject({ layout: "field-notes", highlights });
    expect(store.calls[0].query).toContain("ELSE action_profiles.highlights END");
    expect(store.calls[0].values.slice(-2)).toEqual([false, false]);
    const cleared = await updateShowcaseSettings(owner, { ...legacy, layout: "studio", highlights: [] }, "https://engram.example", store.db);
    expect(cleared.profile).toMatchObject({ layout: "studio", highlights: [] });
  });

  test("projects only the owner's presentation into JSON and SSE and retires it on unpublish", async () => {
    const store = database({ ...profile, layout: "field-notes", highlights });
    const publicValue = await getPublicActivity(profile.slug, store.db, now);
    expect(publicValue?.profile).toEqual({ slug: profile.slug, displayName: profile.displayName, bio: profile.bio, layout: "field-notes", highlights });
    expect(JSON.stringify(publicValue)).not.toMatch(/private task text|private-agent-name|secret-run-id|private@example/);
    const response = await handlePublicShowcase(new Request(`https://engram.example/api/public/activity/${profile.slug}/stream`), store.db);
    const reader = response!.body!.getReader();
    try {
      const frame = new TextDecoder().decode((await reader.read()).value);
      expect(JSON.parse(frame.split("data: ")[1].trim()).profile.highlights).toEqual(highlights);
      store.profiles.set(7, { ...profile, published: false, highlights });
      expect(await getPublicActivity(profile.slug, store.db)).toBeNull();
      expect((await handlePublicShowcase(new Request(`https://engram.example/api/public/activity/${profile.slug}`), store.db))?.status).toBe(404);
    } finally { await reader.cancel(); }
  });

  test("keeps invalid stored links and extra nested fields out of public snapshots", () => {
    for (const unsafe of [[{ ...highlights[0], url: "javascript:alert(1)" }], [{ ...highlights[0], privateText: "do not publish" }]]) {
      const value = publicActivitySnapshot({ ...profile, highlights: unsafe as any }, aggregate, now);
      expect(value.profile.highlights).toEqual([]);
      expect(JSON.stringify(value)).not.toContain("javascript:");
      expect(JSON.stringify(value)).not.toContain("do not publish");
    }
  });

  test("presentation changes retire an in-flight public projection before it can return old owner text", async () => {
    for (const change of [{ layout: "studio" as const }, { highlights: [{ title: "Replacement", body: "New public text", url: "" }] }]) {
      const store = database({ ...profile, layout: "field-notes", highlights });
      store.onAggregate(() => store.profiles.set(7, { ...profile, layout: "field-notes", highlights, ...change }));
      expect(await getPublicActivity(profile.slug, store.db, now)).toBeNull();
    }
  });

  test("accepts a valid multibyte maximum profile within the bounded expanded request limit", async () => {
    const body = JSON.stringify({ ...profile, layout: "field-notes", highlights: Array.from({ length: 3 }, () => ({ title: "界".repeat(80), body: "界".repeat(600), url: "https://example.com/" + "界".repeat(2028) })) });
    const bytes = new TextEncoder().encode(body).byteLength;
    expect(bytes).toBeGreaterThan(10_000); expect(bytes).toBeLessThan(SHOWCASE_PAYLOAD_LIMIT);
    const response = await handleShowcaseApi(new Request("https://engram.example/api/showcase", { method: "PUT", headers: { "content-length": String(bytes) }, body }), owner, database().db);
    expect(response.status).toBe(200);
  });
});

describe("public activity projection", () => {
  test("observes runtime receipts after awaited reads while preserving explicitly injected clocks", async () => {
    const before = new Date("2026-10-25T12:00:00Z"), after = new Date("2026-10-25T12:00:02Z");
    try {
      for (const route of ["json", "preview", "stream", "injected"]) {
        setSystemTime(before);
        const store = database({ ...profile, showActivity: true });
        store.onAggregate(() => {
          setSystemTime(after);
          store.events([{ id: "receipt-during-read", agent: "private-agent", tool: "files.write", status: "running", evidence: "reported", recorded_at: after.toISOString(), harness: "codex" }]);
        });
        let value;
        if (route === "preview") value = (await getShowcaseSettings(owner, "https://engram.example", store.db)).preview;
        else if (route === "stream") {
          const response = await handlePublicShowcase(new Request(`https://engram.example/api/public/activity/${profile.slug}/stream`), store.db);
          const reader = response!.body!.getReader();
          try { value = JSON.parse(new TextDecoder().decode((await reader.read()).value).split("data: ")[1].trim()); }
          finally { await reader.cancel(); }
        } else value = await getPublicActivity(profile.slug, store.db, route === "injected" ? before : undefined);
        expect(value?.activity.events[0].status).toBe(route === "injected" ? "stale" : "running");
        expect(value?.live.checkedAt).toBe((route === "injected" ? before : after).toISOString());
      }
    } finally { setSystemTime(); }
  });

  test("requires explicit activity sharing while authorized owner previews stay safe and useful", async () => {
    const store = database();
    const event = { id: "secret-id", agent: "private-agent", action_key: "secret-action", harness: "codex", tool: "github.create_pull_request", resource: "https://github.com/private-org/private-repo/pull/42", status: "completed", evidence: "reported", recorded_at: now.toISOString(), summary: "secret-summary" };
    store.events([event]);
    const hidden = await getPublicActivity(profile.slug, store.db, now);
    expect(hidden?.activity).toEqual({ enabled: false, events: [] });
    expect(store.calls.some(call => call.query.includes("WITH latest_reports"))).toBe(false);
    const preview = await getShowcaseSettings(owner, "https://engram.example", store.db);
    expect(preview.profile.showActivity).toBe(false);
    expect(preview.preview.activity.events).toHaveLength(1);
    const saved = await updateShowcaseSettings(owner, { ...profile, showActivity: true }, "https://engram.example", store.db);
    expect(saved.profile.showActivity).toBe(true);
    const visible = await getPublicActivity(profile.slug, store.db, now);
    expect(visible?.activity.enabled).toBe(true);
    expect(visible?.activity.events[0].agent).toEqual({ product: "codex", label: "Codex" });
    expect(visible?.activity.events[0].service).toBe("github");
    for (const secret of ["secret-", "private-org", "private-repo", "private-agent", "pull/42"]) expect(JSON.stringify(visible)).not.toContain(secret);
    const query = store.calls.find(call => call.query.includes("WITH latest_reports"))!;
    expect(query.values).toEqual([7, 7]);
    expect(query.query).toContain("LIMIT 20");
    for (const field of ["summary", "task_title", "current_step", "detail", "run_id", "arg_summary"]) expect(query.query).not.toContain(field);
    expect(query.query).toContain("(harness IS NULL AND source_label IS NULL)");
    const { showActivity, ...legacy } = profile;
    expect((await updateShowcaseSettings(owner, legacy, "https://engram.example", store.db)).profile.showActivity).toBe(false);
  });

  test("activity permission changes revoke an in-flight public projection", async () => {
    const store = database({ ...profile, showActivity: true });
    store.events([{ id: "secret", agent: "secret-agent", tool: "search", status: "completed", evidence: "observed", recorded_at: now.toISOString() }]);
    store.onAggregate(() => store.profiles.set(7, { ...profile, showActivity: false }));
    expect(await getPublicActivity(profile.slug, store.db, now)).toBeNull();
  });

  test("uses both action sources, exact organization bindings, aggregate-only SQL and UTC dates", async () => {
    const { db, calls } = database();
    const result = await getPublicActivity(profile.slug, db, now);
    expect(result?.stats).toEqual({ totalActions: 17, completedActions: 13, failedActions: 2, runningActions: 2, activeAgents: 3, activeDays: 4 });
    expect(result?.tools).toEqual([{ category: "code", count: 10 }, { category: "email", count: 7 }]);
    const query = calls[1];
    expect(query.query).toContain("UNION ALL");
    expect(query.query).toContain("FROM action_events WHERE org_id");
    expect(query.query).toContain("FROM audit_log WHERE org_id");
    expect(query.query).toContain("'list_actions', 'record_action', 'whoami'");
    expect(query.query).toContain("AT TIME ZONE 'UTC'");
    expect(query.values).toEqual([7, 7, "2026-10-21T23:48:00.000Z", "2026-07-31T00:00:00.000Z", "2026-10-23T00:00:00.000Z"]);
    expect(query.query).toContain("row_number() OVER");
    expect(query.query).toContain("recorded_at >= bounds.recent_cutoff");
    expect(result?.live).toEqual({ workingAgents: 1, recentlyActiveAgents: 2, completedAgents: 3, failedAgents: 1, workingActions: 1, staleActions: 1, lastActivityAt: "2026-10-22T00:02:00.000Z", checkedAt: now.toISOString(), freshnessSeconds: 900 });
    for (const privateColumn of ["summary", "resource", "detail", "approach", "run_id", "arg_summary", "task_title", "current_step", "harness", "source_label"]) expect(query.query).not.toContain(privateColumn);
    for (const secret of ["private task", "private-agent", "private.example", "private-method-secret", "secret-run", "email", "published", "org_id"]) {
      if (secret === "email") continue; // "email" is an intentionally broad tool category.
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  test("zero fills exactly 84 UTC days and collapses unexpected categories without leaking strings", () => {
    const result = publicActivitySnapshot(profile, { ...aggregate, tools: [{ category: "private_tool_name", count: "2" }, { category: "other", count: 3 }, { category: "code", count: -1 }], daily: [...aggregate.daily, { date: "2026-01-01", count: 999 }, { date: "2026-10-23", count: 999 }], updated_at: "invalid" }, now);
    expect(result.daily).toHaveLength(84);
    expect(result.daily[0]).toEqual({ date: "2026-07-31", count: 0 });
    expect(result.daily.at(-1)).toEqual({ date: "2026-10-22", count: 2 });
    expect(result.daily.reduce((sum, day) => sum + day.count, 0)).toBe(10);
    expect(result.tools).toEqual([{ category: "other", count: 5 }]);
    expect(result.updatedAt).toBeNull();
    expect(JSON.stringify(result)).not.toContain("private_tool_name");
    expect(publicActivitySnapshot(profile, {}, now).stats.totalActions).toBe(0);
  });

  test("uses only generic tool categories", () => {
    const samples = { calendar: "google_calendar.update", email: "gmail.send", code: "github.create_pull_request", cloud: "cloud.deploy", files: "drive.write_file", browser: "browser.click", data: "postgres.query", memory: "remember", other: "private_custom_integration" };
    for (const [category, tool] of Object.entries(samples)) expect(showcaseCategory(tool)).toBe(category);
    expect(showcaseCategory("search")).toBe("memory");
    expect(showcaseCategory("web.search")).toBe("browser");
  });

  test("rejects unsafe public paths without querying and hides unpublished and missing profiles equally", async () => {
    const { db, calls } = database({ ...profile, published: false });
    expect(await getPublicActivity("<script>", db, now)).toBeNull();
    expect(calls).toHaveLength(0);
    for (const slug of [profile.slug, "nonexistent"]) expect(await getPublicActivity(slug, db, now)).toBeNull();
    expect(calls).toHaveLength(2);
  });

  test("rechecks publication after aggregation so an in-flight JSON or stream read cannot cross revocation or slug reassignment", async () => {
    for (const mutation of ["unpublish", "reassign"]) {
      for (const route of ["json", "stream"]) {
        const store = database();
        store.onAggregate(() => {
          if (mutation === "unpublish") store.profiles.set(7, { ...profile, published: false });
          else { store.profiles.delete(7); store.profiles.set(8, { ...profile }); }
        });
        const path = `/api/public/activity/${profile.slug}${route === "stream" ? "/stream" : ""}`;
        const result = await handlePublicShowcase(new Request(`https://engram.example${path}`), store.db);
        expect(result?.status).toBe(404);
        const body = await result!.text();
        expect(body).not.toContain(profile.displayName);
        expect(body).not.toContain("totalActions");
        const aggregateIndex = store.calls.findIndex(call => call.query.includes("WITH ledger"));
        expect(aggregateIndex).toBeGreaterThan(0);
        expect(store.calls[aggregateIndex + 1].query).toContain("FROM action_profiles");
        expect(store.calls[aggregateIndex + 1].query).toContain("published = true");
      }
    }
  });

  test("unpublishes immediately across JSON, HTML, SVG and PNG with no cached public response", async () => {
    const { db } = database();
    const response = await handlePublicShowcase(new Request(`https://engram.example/api/public/activity/${profile.slug}`), db);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(response?.headers.get("access-control-allow-origin")).toBe("*");
    await updateShowcaseSettings(owner, { ...profile, published: false }, "https://engram.example", db);
    for (const path of [`/api/public/activity/${profile.slug}`, `/u/${profile.slug}`, `/api/public/activity/${profile.slug}/card.svg`, `/api/public/activity/${profile.slug}/card.png`]) {
      const result = await handlePublicShowcase(new Request(`https://engram.example${path}`), db);
      expect(result?.status).toBe(404);
      expect(result?.headers.get("cache-control")).toBe("no-store");
      expect(result?.headers.get("x-robots-tag")).toBe("noindex");
      if (path.startsWith("/u/")) {
        expect(result?.headers.get("content-type")).toContain("text/html");
        const page = await result!.text();
        expect(page).toContain("Nothing public here yet.");
        expect(page).not.toContain(profile.displayName);
      }
    }
  });

  test("serves embed preflight, HEAD and method boundaries without authentication", async () => {
    const { db, calls } = database();
    const url = "https://engram.example/api/public/activity/my-agents";
    const options = await handlePublicShowcase(new Request(url, { method: "OPTIONS" }), db);
    expect(options?.status).toBe(204);
    expect(options?.headers.get("access-control-allow-methods")).toContain("GET");
    const post = await handlePublicShowcase(new Request(url, { method: "POST" }), db);
    expect(post?.status).toBe(405);
    expect(calls).toHaveLength(0);
    const head = await handlePublicShowcase(new Request(url, { method: "HEAD" }), db);
    expect(head?.status).toBe(200);
    expect(await head?.text()).toBe("");
    expect(await handlePublicShowcase(new Request("https://engram.example/api/actions"), db)).toBeNull();
  });

  test("escapes profile content and URLs in metadata, fallback HTML and SVG cards", () => {
    const activity = publicActivitySnapshot({ ...profile, displayName: '<img src=x onerror="evil()">', bio: '</title><script>evil()</script>&"' }, aggregate, now);
    const html = renderShowcasePage(activity, "https://engram.example");
    const svg = renderShowcaseCard(activity);
    for (const output of [html, svg]) {
      expect(output).not.toContain("<img src=x");
      expect(output).not.toContain("<script>evil()");
      expect(output).toContain("&lt;");
    }
    expect(html).toContain('property="og:image:type" content="image/png"');
    expect(html).toContain("/card.png");
    expect(html).toContain('href="/showcase.css"');
    expect(html).toContain('id="public-showcase" data-slug="my-agents"');
    expect(svg).not.toContain("private task text");
  });

  test("produces a real 1200×630 PNG using the bundled font", async () => {
    const png = await renderShowcasePng(publicActivitySnapshot(profile, aggregate, now));
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
    expect(png.length).toBeGreaterThan(10_000);
  });
});
