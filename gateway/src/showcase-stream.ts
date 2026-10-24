import type { PublicActivity } from "./showcase-view";

const HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform",
  "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff", "X-Accel-Buffering": "no",
};
const PROCESS_LIMIT = 128;
let processConnections = 0;
// Keep at most four actual public stream database reads in flight, leaving room
// in the shared five-connection gateway pool for authentication and billing.
const PROCESS_LOAD_LIMIT = 4;
let processLoads = 0;
const encoder = new TextEncoder();

export interface ShowcaseStreamSource {
  // A fresh publication lookup is mandatory for every new viewer. Shared
  // snapshots are never sufficient proof that a profile is still public.
  publication(slug: string): Promise<string | null>;
  // Re-check the exact publication binding before querying aggregates. A slug
  // may have been unpublished, edited, or claimed by another tenant meanwhile.
  snapshot(slug: string, expectedPublication: string): Promise<PublicActivity | null>;
}
export interface ShowcaseStreamOptions {
  pollMs?: number;
  heartbeatMs?: number;
  durationMs?: number;
  retryMs?: number;
  loadTimeoutMs?: number;
  maxConnections?: number;
  maxPerProfile?: number;
  maxLoads?: number;
  queueBytes?: number;
  now?: () => number;
}
interface Subscriber {
  controller: ReadableStreamDefaultController<Uint8Array>;
  signal: AbortSignal;
  abort: () => void;
  release: () => void;
  rollover?: ReturnType<typeof setTimeout>;
  closed: boolean;
}
interface Hub {
  slug: string;
  publication: string;
  subscribers: Set<Subscriber>;
  ready: Promise<PublicActivity | null>;
  last: PublicActivity | null;
  fingerprint: string;
  timer?: ReturnType<typeof setInterval>;
  waiters: number;
  busy: boolean;
  stopped: boolean;
  heartbeatAt: number;
}
function positive(value: number | undefined, fallback: number) {
  return value && Number.isFinite(value) && value > 0 ? value : fallback;
}
function fingerprint(activity: PublicActivity): string {
  // A successful check with unchanged data needs no new data event. Time-based
  // working/stale counts still change this fingerprint at their actual boundary.
  return JSON.stringify({ ...activity, live: { ...activity.live, checkedAt: undefined } });
}
function event(type: "snapshot" | "closed", data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Per-process fan-out; each public slug has one database poll regardless of viewers. */
export function createShowcaseStreamManager(source: ShowcaseStreamSource, options: ShowcaseStreamOptions = {}) {
  const settings = {
    pollMs: positive(options.pollMs, 5000), heartbeatMs: positive(options.heartbeatMs, 15_000),
    durationMs: positive(options.durationMs, 90_000), retryMs: positive(options.retryMs, 5000),
    loadTimeoutMs: positive(options.loadTimeoutMs, 10_000), queueBytes: positive(options.queueBytes, 32_768),
    maxConnections: Math.min(PROCESS_LIMIT, positive(options.maxConnections, PROCESS_LIMIT)),
    maxPerProfile: Math.min(PROCESS_LIMIT, positive(options.maxPerProfile, 32)),
    maxLoads: Math.min(PROCESS_LOAD_LIMIT, positive(options.maxLoads, PROCESS_LOAD_LIMIT)),
  };
  const now = options.now ?? Date.now;
  const hubs = new Map<string, Hub>();
  let connections = 0;
  let loads = 0;
  let disposed = false;
  async function bounded<T>(load: () => Promise<T>): Promise<T> {
    if (disposed || loads >= settings.maxLoads || processLoads >= PROCESS_LOAD_LIMIT) throw new Error("unavailable");
    loads++; processLoads++;
    // A response timeout does not cancel PostgreSQL work. Retain this lease
    // until the source really settles, including after client/manager closure.
    const promise = Promise.resolve().then(load).finally(() => { loads--; processLoads--; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("unavailable")), settings.loadTimeoutMs); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  function reserve() {
    if (disposed || connections >= settings.maxConnections || processConnections >= PROCESS_LIMIT) return null;
    connections++; processConnections++;
    let released = false;
    return () => { if (!released) { released = true; connections--; processConnections--; } };
  }
  function stopIfUnused(hub: Hub) {
    if (hub.subscribers.size || hub.waiters) return;
    hub.stopped = true;
    if (hub.timer) clearInterval(hub.timer);
    if (hubs.get(hub.slug) === hub) hubs.delete(hub.slug);
  }
  function finish(hub: Hub, subscriber: Subscriber, reason?: "unpublished" | "unavailable", canceled = false) {
    if (subscriber.closed) return;
    subscriber.closed = true;
    if (subscriber.rollover) clearTimeout(subscriber.rollover);
    subscriber.signal.removeEventListener("abort", subscriber.abort);
    hub.subscribers.delete(subscriber);
    if (!canceled) {
      try {
        if (reason) subscriber.controller.enqueue(encoder.encode(event("closed", { reason })));
        subscriber.controller.close();
      } catch { /* The browser may already have canceled its reader. */ }
    }
    subscriber.release();
    stopIfUnused(hub);
  }
  function send(hub: Hub, subscriber: Subscriber, value: string) {
    if (subscriber.closed) return;
    if ((subscriber.controller.desiredSize ?? 0) <= 0) { finish(hub, subscriber); return; }
    try { subscriber.controller.enqueue(encoder.encode(value)); }
    catch { finish(hub, subscriber); }
  }
  function broadcast(hub: Hub, value: string) {
    for (const subscriber of [...hub.subscribers]) send(hub, subscriber, value);
  }
  async function refresh(hub: Hub) {
    if (hub.stopped || !hub.subscribers.size) return;
    if (now() - hub.heartbeatAt >= settings.heartbeatMs) {
      broadcast(hub, ": heartbeat\n\n"); hub.heartbeatAt = now();
    }
    if (hub.busy || hub.stopped) return;
    hub.busy = true;
    try {
      const activity = await bounded(() => source.snapshot(hub.slug, hub.publication));
      if (hub.stopped) return;
      if (!activity) {
        retire(hub);
        return;
      }
      const signature = fingerprint(activity);
      hub.last = activity;
      if (signature !== hub.fingerprint) {
        hub.fingerprint = signature;
        broadcast(hub, event("snapshot", activity));
      }
    } catch {
      for (const subscriber of [...hub.subscribers]) finish(hub, subscriber, "unavailable");
    } finally { hub.busy = false; }
  }
  function retire(hub: Hub) {
    hub.stopped = true;
    hub.last = null;
    if (hub.timer) clearInterval(hub.timer);
    for (const subscriber of [...hub.subscribers]) finish(hub, subscriber, "unpublished");
    if (hubs.get(hub.slug) === hub) hubs.delete(hub.slug);
  }
  function getHub(slug: string, publication: string): Hub {
    const existing = hubs.get(slug);
    if (existing?.publication === publication) return existing;
    if (existing) retire(existing);
    const hub: Hub = { slug, publication, subscribers: new Set(), ready: Promise.resolve(null), last: null, fingerprint: "", waiters: 0, busy: false, stopped: false, heartbeatAt: now() };
    hub.ready = bounded(() => source.snapshot(slug, publication)).then(activity => {
      if (hub.stopped) return null;
      hub.last = activity;
      if (activity) hub.fingerprint = fingerprint(activity);
      return activity;
    });
    hubs.set(slug, hub);
    return hub;
  }
  const unavailable = () => new Response("Live activity is temporarily unavailable", { status: 503, headers: { ...HEADERS, "Retry-After": "5" } });
  async function handle(req: Request, slug: string): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...HEADERS, "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS" } });
    if (!["GET", "HEAD"].includes(req.method)) return new Response("Method Not Allowed", { status: 405, headers: { ...HEADERS, Allow: "GET, HEAD, OPTIONS" } });
    if (!/^(?=.{3,48}$)[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return new Response("Not Found", { status: 404, headers: HEADERS });
    if (req.signal.aborted) return new Response(null, { status: 204, headers: HEADERS });
    const release = req.method === "GET" ? reserve() : () => {};
    if (!release) return unavailable();
    let handedOff = false;
    let waiting = false;
    let hub: Hub | undefined;
    try {
      const publication = await bounded(() => source.publication(slug));
      if (!publication) {
        const existing = hubs.get(slug);
        if (existing) retire(existing);
        return new Response("Not Found", { status: 404, headers: { ...HEADERS, "X-Robots-Tag": "noindex" } });
      }
      if (req.method === "HEAD") return new Response(null, { headers: HEADERS });
      if (req.signal.aborted || disposed) return new Response(null, { status: 204, headers: HEADERS });
      hub = getHub(slug, publication);
      if (hub.subscribers.size + hub.waiters >= settings.maxPerProfile) return unavailable();
      hub.waiters++;
      waiting = true;
      const activity = await hub.ready;
      if (!activity) return new Response("Not Found", { status: 404, headers: { ...HEADERS, "X-Robots-Tag": "noindex" } });
      if (req.signal.aborted || disposed || hub.stopped) return new Response(null, { status: 204, headers: HEADERS });
      const target = hub;
      let subscriber: Subscriber;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          subscriber = { controller, signal: req.signal, release, closed: false, abort: () => finish(target, subscriber) };
          target.subscribers.add(subscriber);
          req.signal.addEventListener("abort", subscriber.abort, { once: true });
          send(target, subscriber, `retry: ${settings.retryMs}\n\n${event("snapshot", target.last ?? activity)}`);
          subscriber.rollover = setTimeout(() => finish(target, subscriber), settings.durationMs);
          subscriber.rollover.unref?.();
          if (!target.timer) {
            target.timer = setInterval(() => { void refresh(target); }, settings.pollMs);
            target.timer.unref?.();
          }
          if (req.signal.aborted) finish(target, subscriber);
        },
        cancel() { finish(target, subscriber, undefined, true); },
      }, { highWaterMark: settings.queueBytes, size: chunk => chunk.byteLength });
      handedOff = true;
      return new Response(stream, { headers: HEADERS });
    } catch { return unavailable(); }
    finally {
      if (hub && waiting) hub.waiters--;
      if (!handedOff) release();
      if (hub) stopIfUnused(hub);
    }
  }
  return {
    handle,
    // Used by graceful shutdown and deterministic stream lifecycle checks.
    async refresh() { await Promise.all([...hubs.values()].map(hub => refresh(hub))); },
    close() {
      disposed = true;
      for (const hub of [...hubs.values()]) {
        for (const subscriber of [...hub.subscribers]) finish(hub, subscriber, "unavailable");
        stopIfUnused(hub);
      }
    },
    status() { return { connections, profiles: hubs.size }; },
  };
}
