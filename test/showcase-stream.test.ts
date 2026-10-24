import { describe, expect, test } from "bun:test";
import { createShowcaseStreamManager, type ShowcaseStreamSource } from "../gateway/src/showcase-stream";
import { publicActivitySnapshot } from "../gateway/src/showcase-view";

const profile = { slug: "my-agents", displayName: "Ada", bio: "Building", published: true };
const at = new Date("2026-10-22T12:00:00Z");
const activity = () => publicActivitySnapshot(profile, { total_actions: 3, completed_actions: 2, running_actions: 1, active_agents: 2, working_agents: 1, working_actions: 1, completed_agents: 1, recently_active_agents: 2, last_activity_at: at }, at);
const request = (signal?: AbortSignal, method = "GET") => new Request("https://engram.example/api/public/activity/my-agents/stream", { method, signal });
const decoder = new TextDecoder();
async function chunk(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const result = await reader.read();
  return { done: result.done, text: result.value ? decoder.decode(result.value) : "" };
}
function data(text: string) {
  return JSON.parse(text.split("\n").find(line => line.startsWith("data: "))!.slice(6));
}
function source() {
  let published = true, failure = false, snapshots = 0, publicationChecks = 0, revision = 1;
  let current = activity();
  const service: ShowcaseStreamSource = {
    async publication() { publicationChecks++; if (failure) throw new Error("secret database details"); return published ? `tenant-a:${revision}` : null; },
    async snapshot(_slug, expected) { snapshots++; if (failure) throw new Error("secret database details"); return published && expected === `tenant-a:${revision}` ? current : null; },
  };
  return { service, publish: (value: boolean) => { published = value; revision++; }, replace: (name: string) => { revision++; current = { ...current, profile: { ...current.profile, displayName: name } }; }, fail: () => { failure = true; }, change: (count: number) => { current = { ...current, stats: { ...current.stats, totalActions: count } }; }, checkTime: (time: Date) => { current = { ...current, live: { ...current.live, checkedAt: time.toISOString() } }; }, counts: () => ({ snapshots, publicationChecks }) };
}

describe("public activity event streams", () => {
  test("sends public aggregate snapshots with CORS and shares one poll across viewers", async () => {
    const backend = source(); const manager = createShowcaseStreamManager(backend.service);
    try {
      const [one, two] = await Promise.all([manager.handle(request(), profile.slug), manager.handle(request(), profile.slug)]);
      expect(one.status).toBe(200);
      expect(one.headers.get("content-type")).toContain("text/event-stream");
      expect(one.headers.get("cache-control")).toContain("no-store");
      expect(one.headers.get("access-control-allow-origin")).toBe("*");
      expect(one.headers.has("access-control-allow-credentials")).toBe(false);
      expect(one.headers.get("x-accel-buffering")).toBe("no");
      const first = one.body!.getReader(), second = two.body!.getReader();
      const initial = await chunk(first);
      expect(initial.text).toStartWith("retry: 5000\n\nevent: snapshot\n");
      expect(data(initial.text)).toEqual(activity());
      await chunk(second);
      expect(backend.counts()).toEqual({ snapshots: 1, publicationChecks: 2 });
      backend.change(4);
      await manager.refresh();
      expect(data((await chunk(first)).text).stats.totalActions).toBe(4);
      expect(data((await chunk(second)).text).stats.totalActions).toBe(4);
      expect(backend.counts().snapshots).toBe(2);
      await first.cancel(); await second.cancel();
      expect(manager.status()).toEqual({ connections: 0, profiles: 0 });
    } finally { manager.close(); }
  });

  test("never uses a shared snapshot as evidence of publication and revokes existing viewers", async () => {
    const backend = source(); const manager = createShowcaseStreamManager(backend.service);
    try {
      const first = await manager.handle(request(), profile.slug); const reader = first.body!.getReader();
      await chunk(reader);
      backend.publish(false);
      expect((await manager.handle(request(), profile.slug)).status).toBe(404);
      await manager.refresh();
      const revoked = await chunk(reader);
      expect(revoked.text).toContain("event: closed\n");
      expect(data(revoked.text)).toEqual({ reason: "unpublished" });
      expect(revoked.text).not.toContain(profile.displayName);
      expect((await chunk(reader)).done).toBe(true);
      expect(manager.status()).toEqual({ connections: 0, profiles: 0 });
    } finally { manager.close(); }
  });

  test("sends heartbeat comments for unchanged data without announcing a false data change", async () => {
    let time = 1000;
    const backend = source(); const manager = createShowcaseStreamManager(backend.service, { now: () => time });
    try {
      const response = await manager.handle(request(), profile.slug), reader = response.body!.getReader();
      await chunk(reader);
      time += 15_000; backend.checkTime(new Date(at.getTime() + 15_000));
      await manager.refresh();
      expect((await chunk(reader)).text).toBe(": heartbeat\n\n");
      expect(backend.counts().snapshots).toBe(2);
      await reader.cancel();
    } finally { manager.close(); }
  });

  test("disconnects immediately on request abort or reader cancellation", async () => {
    const backend = source(); const manager = createShowcaseStreamManager(backend.service);
    try {
      const abort = new AbortController();
      const response = await manager.handle(request(abort.signal), profile.slug), reader = response.body!.getReader();
      await chunk(reader); abort.abort();
      expect((await chunk(reader)).done).toBe(true);
      expect(manager.status()).toEqual({ connections: 0, profiles: 0 });
      const another = await manager.handle(request(), profile.slug);
      await another.body!.cancel();
      expect(manager.status()).toEqual({ connections: 0, profiles: 0 });
    } finally { manager.close(); }
  });

  test("bounds connection counts, releases capacity, and disconnects slow readers", async () => {
    const backend = source(); const manager = createShowcaseStreamManager(backend.service, { maxConnections: 2, maxPerProfile: 2, queueBytes: 1 });
    try {
      const first = await manager.handle(request(), profile.slug);
      const second = await manager.handle(request(), profile.slug);
      const saturated = await manager.handle(request(), profile.slug);
      expect(saturated.status).toBe(503);
      expect(saturated.headers.get("retry-after")).toBe("5");
      backend.change(4); await manager.refresh(); // Neither viewer has consumed its initial frame.
      expect(manager.status()).toEqual({ connections: 0, profiles: 0 });
      await first.body!.cancel(); await second.body!.cancel();
      const next = await manager.handle(request(), profile.slug);
      expect(next.status).toBe(200); await next.body!.cancel();
    } finally { manager.close(); }
  });

  test("rolls over connections for native EventSource reconnection and contains storage failures", async () => {
    const backend = source(); const manager = createShowcaseStreamManager(backend.service, { durationMs: 20 });
    try {
      const response = await manager.handle(request(), profile.slug), reader = response.body!.getReader();
      await chunk(reader);
      expect((await chunk(reader)).done).toBe(true);
      expect(manager.status().connections).toBe(0);
      const replacement = await manager.handle(request(), profile.slug), replacementReader = replacement.body!.getReader();
      await chunk(replacementReader); backend.fail(); await manager.refresh();
      const closed = await chunk(replacementReader);
      expect(data(closed.text)).toEqual({ reason: "unavailable" });
      expect(closed.text).not.toContain("secret");
      expect((await chunk(replacementReader)).done).toBe(true);
    } finally { manager.close(); }
  });

  test("bounds slow initial loads and never allocates live connections for HEAD or preflight", async () => {
    const backend = source(); const manager = createShowcaseStreamManager(backend.service);
    try {
      expect((await manager.handle(request(undefined, "OPTIONS"), profile.slug)).status).toBe(204);
      expect((await manager.handle(request(undefined, "HEAD"), profile.slug)).status).toBe(200);
      expect((await manager.handle(request(undefined, "POST"), profile.slug)).status).toBe(405);
      expect((await manager.handle(request(), "../private")).status).toBe(404);
      expect(manager.status()).toEqual({ connections: 0, profiles: 0 });
      expect(backend.counts()).toEqual({ publicationChecks: 1, snapshots: 0 });
    } finally { manager.close(); }
    let settle: (value: null) => void = () => {};
    const slow = createShowcaseStreamManager({ publication: async () => "revision", snapshot: () => new Promise(resolve => { settle = resolve; }) }, { loadTimeoutMs: 10 });
    try {
      expect((await slow.handle(request(), profile.slug)).status).toBe(503);
      expect(slow.status()).toEqual({ connections: 0, profiles: 0 });
    } finally { settle(null); await Promise.resolve(); slow.close(); }
  });

  test("slug reassignment or republication invalidates old shared frames before a new viewer receives data", async () => {
    for (const change of ["reassigned", "republished"]) {
      const backend = source(), manager = createShowcaseStreamManager(backend.service);
      try {
        const before = await manager.handle(request(), profile.slug), oldReader = before.body!.getReader();
        await chunk(oldReader);
        if (change === "reassigned") backend.replace("Different tenant");
        else { backend.publish(false); backend.publish(true); backend.change(99); }
        const after = await manager.handle(request(), profile.slug), newReader = after.body!.getReader();
        const initial = data((await chunk(newReader)).text);
        if (change === "reassigned") expect(initial.profile.displayName).toBe("Different tenant");
        else expect(initial.stats.totalActions).toBe(99);
        expect(data((await chunk(oldReader)).text)).toEqual({ reason: "unpublished" });
        expect((await chunk(oldReader)).done).toBe(true);
        expect(backend.counts().snapshots).toBe(2);
        await newReader.cancel();
      } finally { manager.close(); }
    }
  });

  test("timed-out source work retains its lease until actual settlement so retries cannot stack abandoned reads", async () => {
    let snapshots = 0, publications = 0;
    let settle: (value: null) => void = () => {};
    const manager = createShowcaseStreamManager({
      async publication() { publications++; return "revision"; },
      snapshot() {
        snapshots++;
        return snapshots === 1 ? new Promise(resolve => { settle = resolve; }) : Promise.resolve(activity());
      },
    }, { loadTimeoutMs: 5, maxLoads: 1 });
    try {
      expect((await manager.handle(request(), profile.slug)).status).toBe(503);
      expect(manager.status()).toEqual({ connections: 0, profiles: 0 });
      for (let retry = 0; retry < 3; retry++) expect((await manager.handle(request(), profile.slug)).status).toBe(503);
      expect({ publications, snapshots }).toEqual({ publications: 1, snapshots: 1 });
      settle(null); await Promise.resolve(); await Promise.resolve();
      const recovered = await manager.handle(request(), profile.slug);
      expect(recovered.status).toBe(200);
      expect({ publications, snapshots }).toEqual({ publications: 2, snapshots: 2 });
      await recovered.body!.cancel();
    } finally { settle(null); manager.close(); }
  });

  test("the process work limit survives manager shutdown and is shared across stream managers", async () => {
    let snapshots = 0;
    const pending: ((value: null) => void)[] = [];
    const managers = Array.from({ length: 5 }, () => createShowcaseStreamManager({
      async publication() { return "revision"; },
      snapshot() { snapshots++; return new Promise(resolve => { pending.push(resolve); }); },
    }, { loadTimeoutMs: 5 }));
    const recovered = createShowcaseStreamManager({ publication: async () => "revision", snapshot: async () => activity() });
    try {
      const responses = await Promise.all(managers.map(manager => manager.handle(request(), profile.slug)));
      expect(responses.map(response => response.status)).toEqual([503, 503, 503, 503, 503]);
      expect(snapshots).toBe(4);
      managers.forEach(manager => manager.close());
      expect((await recovered.handle(request(), profile.slug)).status).toBe(503);
      pending.forEach(resolve => resolve(null)); await Promise.resolve(); await Promise.resolve();
      const available = await recovered.handle(request(), profile.slug);
      expect(available.status).toBe(200); await available.body!.cancel();
    } finally {
      pending.forEach(resolve => resolve(null)); managers.forEach(manager => manager.close()); recovered.close();
    }
  });
});
