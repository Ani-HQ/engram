import type postgres from "postgres";
import { failureCode } from "../diagnostics";
import { dataSql } from "../db";

export const DREAM_LOCK_KEY = 814229;

export type DreamLock = { release(): Promise<void> };

// A session advisory lock belongs to one connection. Take and release it on
// one reserved connection, or a pooled unlock can land on another session and
// leave the lock held until that connection closes.
export async function tryDreamLock(db: postgres.Sql = dataSql()): Promise<DreamLock | null> {
  let reserved: postgres.ReservedSql | undefined;
  try {
    reserved = await db.reserve();
    const rows = await reserved`SELECT pg_try_advisory_lock(${DREAM_LOCK_KEY}) AS locked`;
    if (!rows[0]?.locked) { reserved.release(); return null; }
    const held = reserved;
    return {
      async release() {
        try {
          await held`SELECT pg_advisory_unlock(${DREAM_LOCK_KEY})`;
        } catch (e) {
          console.error("[dream] unlock failed:", failureCode(e));
        } finally {
          held.release();
        }
      },
    };
  } catch (e) {
    reserved?.release();
    console.error("[dream] lock failed:", failureCode(e));
    return null;
  }
}

export function nightKey(now = new Date(), timeZone = "Asia/Kolkata"): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
