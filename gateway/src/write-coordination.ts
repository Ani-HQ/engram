import { AsyncLocalStorage } from "node:async_hooks";
import postgres from "postgres";
import { dbUrl } from "./config";
import { currentContext } from "./context";

// A separate small pool keeps writers waiting for another revision from consuming
// the authentication pool. The transaction owns the lock until *all* engine work
// finishes. Compare-and-swap on engine page writes additionally rejects stale
// content after a connection loss; the lock is coordination, not a fencing token.
const coordination = postgres(dbUrl("engram_gateway"), { max: 8, connect_timeout: 3, idle_timeout: 20, onnotice() {} });
type Lease = { lost: boolean; verify: () => Promise<void> };
const held = new AsyncLocalStorage<ReadonlyMap<number, Lease>>();
let pending = 0;

export async function withMemoryWriteLock<T>(work: () => Promise<T>): Promise<T> {
  const ctx = currentContext();
  if (!ctx || ctx.token.orgId !== ctx.org.id) throw new Error("A matching workspace context is required for memory writes");
  const id = ctx.org.id;
  const existing = held.getStore()?.get(id);
  if (existing) { await existing.verify(); if (existing.lost) throw new Error("Memory write coordination was interrupted"); return work(); }
  if (pending >= 32) throw new Error("Memory writes are busy. Please retry shortly.");
  pending++;
  try {
    return await coordination.begin(async tx => {
      await tx`SET LOCAL lock_timeout = '5s'`;
      await tx`SET LOCAL statement_timeout = '10s'`;
      await tx`SET LOCAL idle_in_transaction_session_timeout = '30s'`;
      await tx`SELECT pg_advisory_xact_lock(1162757965, ${id}::integer)`;
      let lossCleanup: Promise<unknown> | null = null;
      const lease: Lease = { lost:false, async verify() {
        if (lease.lost) throw new Error("Memory write coordination was interrupted");
        try { await tx`SELECT 1`; }
        catch {
          lease.lost = true;
          lossCleanup ??= import("./brain").then(brain => brain.evictBrain(id));
          await lossCleanup;
          throw new Error("Memory write coordination was interrupted");
        }
      }};
      let heartbeat: Promise<unknown> | null = null;
      const timer = setInterval(() => { if (!heartbeat) heartbeat = lease.verify().catch(() => {}).finally(() => { heartbeat = null; }); },5000);
      timer.unref?.();
      try {
        const result = await held.run(new Map([...(held.getStore() ?? []), [id,lease]]),work);
        await lease.verify();
        return result;
      } finally { clearInterval(timer); await heartbeat; await lossCleanup; }
    }) as T;
  } finally { pending--; }
}

export function isMemoryMutation(name: string): boolean {
  return new Set(["put_page", "delete_page", "restore_page", "add_tag", "remove_tag", "add_link", "remove_link", "add_timeline_entry", "update_timeline_entry", "delete_timeline_entry"]).has(name);
}

export async function closeWriteCoordinator(): Promise<void> {
  await coordination.end({ timeout: 2 });
}
