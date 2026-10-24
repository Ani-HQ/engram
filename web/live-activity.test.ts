import { describe, expect, test } from "bun:test";
import { watchPublicActivity } from "./live-activity.js";

class Source {
  static instances: Source[] = [];
  readyState = 0;
  closed = false;
  handlers = new Map<string, Function[]>();
  constructor(public url: string, public options: any) { Source.instances.push(this); }
  addEventListener(name: string, handler: Function) { this.handlers.set(name, [...(this.handlers.get(name) || []), handler]); }
  emit(name: string, data?: any) { for (const handler of this.handlers.get(name) || []) handler({ data: JSON.stringify(data) }); }
  close() { this.closed = true; this.readyState = 2; }
}
const data = { profile: { slug: "sample" }, stats: { totalActions: 1 }, live: { workingAgents: 1 } };

describe("public live activity client", () => {
  test("receives aggregate snapshots and ignores a closed or paused connection's late events", () => {
    const values: any[] = [], states: string[] = [];
    const watcher = watchPublicActivity("/api/public/activity/sample/stream", { snapshot: value => values.push(value), state: value => states.push(value), closed() {} }, { EventSourceClass: Source });
    const first = Source.instances.at(-1)!;
    expect(first.options.withCredentials).toBe(false);
    first.emit("open"); first.emit("snapshot", data);
    watcher.pause(); first.emit("snapshot", { ...data, live: { workingAgents: 99 } });
    expect(values).toEqual([data]); expect(states.at(-1)).toBe("paused"); expect(first.closed).toBe(true);
    watcher.resume(); const second = Source.instances.at(-1)!;
    expect(second).not.toBe(first); second.emit("snapshot", data); expect(values).toHaveLength(2);
    watcher.stop(); second.emit("snapshot", data); expect(values).toHaveLength(2);
  });
  test("unpublishing clears the view and permanently stops native reconnects", () => {
    const reasons: string[] = [], values: any[] = [];
    const watcher = watchPublicActivity("/api/public/activity/sample/stream", { snapshot: value => values.push(value), state() {}, closed: reason => reasons.push(reason) }, { EventSourceClass: Source });
    const source = Source.instances.at(-1)!;
    source.emit("closed", { reason: "unpublished" }); source.emit("snapshot", data); watcher.pause(); watcher.resume();
    expect(reasons).toEqual(["unpublished"]); expect(source.closed).toBe(true); expect(values).toEqual([]);
  });
  test("a missing profile discovered after a network error revokes the view, while an outage keeps retrying", async () => {
    const reasons: string[] = [], states: string[] = [];
    const watcher = watchPublicActivity("/api/public/activity/sample/stream", { snapshot() {}, state: value => states.push(value), closed: reason => reasons.push(reason) }, { EventSourceClass: Source, fetcher: async () => new Response(null, { status: 404 }) });
    Source.instances.at(-1)!.emit("error"); await Promise.resolve(); await Promise.resolve();
    expect(reasons).toEqual(["unpublished"]); expect(states.at(-1)).toBe("closed"); watcher.stop();
    const retrying = watchPublicActivity("/api/public/activity/sample/stream", { snapshot() {}, state: value => states.push(value), closed: reason => reasons.push(reason) }, { EventSourceClass: Source, fetcher: async () => new Response(null, { status: 503 }) });
    Source.instances.at(-1)!.emit("error"); await Promise.resolve(); await Promise.resolve();
    expect(states.at(-1)).toBe("reconnecting"); expect(reasons).toEqual(["unpublished"]); retrying.stop();
  });
  test("a server outage removes the stale view and reconnects after checking publication again", async () => {
    const states: string[] = [], reasons: string[] = [], values: any[] = [];
    let interrupted = 0, checks = 0;
    const watcher = watchPublicActivity("/api/public/activity/sample/stream", {
      snapshot: value => values.push(value), state: value => states.push(value), closed: reason => reasons.push(reason), interrupted: () => interrupted++,
    }, { EventSourceClass: Source, retryMs: 1, fetcher: async () => { checks++; return new Response(null, { status: 200 }); } });
    const first = Source.instances.at(-1)!;
    first.emit("snapshot", data); first.emit("closed", { reason: "unavailable" });
    expect(first.closed).toBe(true); expect(interrupted).toBe(1); expect(states.at(-1)).toBe("reconnecting");
    await new Promise(resolve => setTimeout(resolve, 10));
    const next = Source.instances.at(-1)!;
    expect(checks).toBe(1); expect(next).not.toBe(first); expect(reasons).toEqual([]);
    next.emit("snapshot", data); expect(values).toHaveLength(2); expect(states.at(-1)).toBe("live"); watcher.stop();
  });
});
