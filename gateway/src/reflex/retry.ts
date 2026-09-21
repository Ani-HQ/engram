export function retryDelayMs(attempt: number, retryAfterSec?: number): number {
  if (retryAfterSec && retryAfterSec > 0) return Math.min(retryAfterSec * 1000, 60_000);
  return Math.min(60_000, 1000 * 2 ** attempt);
}
