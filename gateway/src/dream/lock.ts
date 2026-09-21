import { sql } from "../db";

export const DREAM_LOCK_KEY = 814229;

export async function tryDreamLock(): Promise<boolean> {
  try {
    const rows = await sql`SELECT pg_try_advisory_lock(${DREAM_LOCK_KEY}) AS locked`;
    return Boolean(rows[0]?.locked);
  } catch (e) {
    console.error("[dream] lock failed:", String(e).slice(0, 200));
    return false;
  }
}

export async function releaseDreamLock(): Promise<void> {
  try {
    await sql`SELECT pg_advisory_unlock(${DREAM_LOCK_KEY})`;
  } catch (e) {
    console.error("[dream] unlock failed:", String(e).slice(0, 200));
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
