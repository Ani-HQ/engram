import { describe, expect, test } from "bun:test";
import { DREAM_LOCK_KEY, tryDreamLock } from "../gateway/src/dream/lock";

// Fake pool: session locks are per connection, as in Postgres.
function fakePool(connections = 3) {
  const holder = new Map<number, number>();
  const log: string[] = [];
  let next = 0, reservedOut = 0;
  const conn = (id: number) => {
    const q = (strings: TemplateStringsArray, key: number) => {
      const sqlText = strings.join("?");
      if (sqlText.includes("pg_try_advisory_lock")) {
        const owner = holder.get(key);
        if (owner === undefined || owner === id) { holder.set(key, id); log.push(`lock@${id}`); return Promise.resolve([{ locked: true }]); }
        return Promise.resolve([{ locked: false }]);
      }
      if (sqlText.includes("pg_advisory_unlock")) {
        log.push(`unlock@${id}`);
        const ok = holder.get(key) === id; if (ok) holder.delete(key);
        return Promise.resolve([{ pg_advisory_unlock: ok }]);
      }
      throw new Error("unexpected query");
    };
    return Object.assign(q, { release: () => { reservedOut--; log.push(`release@${id}`); } });
  };
  const pool = { reserve: async () => { reservedOut++; return conn(next++ % connections); } };
  return { pool: pool as any, holder, log, out: () => reservedOut };
}

describe("dream lock", () => {
  test("unlocks on the connection that took the lock and returns it to the pool", async () => {
    const f = fakePool();
    const lock = await tryDreamLock(f.pool);
    expect(lock).not.toBeNull();
    await lock!.release();
    expect(f.holder.has(DREAM_LOCK_KEY)).toBe(false);
    expect(f.log).toEqual(["lock@0", "unlock@0", "release@0"]);
    expect(f.out()).toBe(0);
  });

  test("a second job is refused while held, and can run after release", async () => {
    const f = fakePool();
    const first = await tryDreamLock(f.pool);
    expect(await tryDreamLock(f.pool)).toBeNull();
    expect(f.out()).toBe(1);
    await first!.release();
    const third = await tryDreamLock(f.pool);
    expect(third).not.toBeNull();
    await third!.release();
    expect(f.out()).toBe(0);
  });

  test("a failed reserve reports no lock", async () => {
    const lock = await tryDreamLock({ reserve: async () => { throw new Error("pool down"); } } as any);
    expect(lock).toBeNull();
  });
});
