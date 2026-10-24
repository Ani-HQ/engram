// Child gateway process used only by integration-tenant-security.ts.
import postgres from "postgres";
import { dbUrl } from "../gateway/src/config";
import { runWithContext } from "../gateway/src/context";
import { DEFAULT_POLICIES, normalizeToken } from "../gateway/src/policies";
import { closeWriteCoordinator, withMemoryWriteLock } from "../gateway/src/write-coordination";

const target = new URL(dbUrl("engram_gateway"));
if (target.hostname !== "127.0.0.1" || target.port !== "15432" || target.username !== "engram_gateway_security_test") throw new Error("Disposable lock-test runtime required");
const [rawId, label, group, barrier] = process.argv.slice(2);
const id = Number(rawId);
if (!Number.isSafeInteger(id) || id < 1 || !/^[a-z-]+$/.test(label ?? "") || !/^[a-z-]+$/.test(group ?? "")) throw new Error("Invalid lock-test identity");
const db = postgres(target.toString(), { max: 1, onnotice() {} });
try {
  await runWithContext({
    org: { id, name: "Disposable", slug: "disposable", kind: "personal", brainDb: `brain_org_${id}`, dataDb: `brain_org_${id}`, homeDir: `org-${id}`, policies: DEFAULT_POLICIES },
    token: normalizeToken({ name: label, orgId: id }), dataSql: db,
  }, () => withMemoryWriteLock(async () => {
    await db`INSERT INTO _engram_write_lock_probe (label, group_id, org_id, phase) VALUES (${label}, ${group}, ${id}, 'start')`;
    if (barrier === "barrier") {
      const deadline = Date.now() + 3_000;
      while (Number((await db`SELECT count(*) AS n FROM _engram_write_lock_probe WHERE group_id = ${group} AND phase = 'start'`)[0].n) < 2) {
        if (Date.now() > deadline) throw new Error("Independent tenant locks blocked each other");
        await Bun.sleep(20);
      }
    }
    // A nested engine mutation must reuse the enclosing append lock.
    await withMemoryWriteLock(async () => { await Bun.sleep(150); });
    await db`INSERT INTO _engram_write_lock_probe (label, group_id, org_id, phase) VALUES (${label}, ${group}, ${id}, 'end')`;
  }));
} finally {
  await db.end({ timeout: 2 });
  await closeWriteCoordinator();
}
