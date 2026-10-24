/**
 * Row 108 (SA-706h, #3213 client condition): the driver's stop completion keeps ONE idempotency key per stop across
 * retries, so the server's key (RF-019) recognises a retry after a lost response or a refused lock, and a 503
 * LOCK_UNAVAILABLE (refused before any write) is retried with that same key. The key is released once the completion
 * lands, is handed to the offline queue (which persists its own copy), is already completed, or is refused for good.
 * In memory only: a restarted app starts a fresh attempt, which the server's "stop already completed" check covers.
 */
const keys = new Map<string, string>();

export function stopCompletionKey(stopId: string): string {
  let key = keys.get(stopId);
  if (!key) {
    key = `stop-${stopId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    keys.set(stopId, key);
  }
  return key;
}

export function releaseStopCompletionKey(stopId: string): void {
  keys.delete(stopId);
}

const responseOf = (err: unknown) =>
  (err as { response?: { status?: number; data?: { code?: unknown } } } | null)?.response;

/** The 503 the completion's lock answers before any write (apps/api/src/common/db-locks.ts). */
export function isLockUnavailable(err: unknown): boolean {
  const res = responseOf(err);
  return res?.status === 503 && res.data?.code === "LOCK_UNAVAILABLE";
}

/**
 * Keep the key when the outcome is unknown (no response, a 5xx) or nothing was written (lock contention), so the next
 * attempt is the SAME request; release it on any other refusal, where the driver's next attempt is a new one.
 */
export function keepsStopCompletionKey(err: unknown): boolean {
  const res = responseOf(err);
  if (!res || res.status === undefined || res.status >= 500) return true;
  return res.status === 409 && res.data?.code === "MERGE_IN_PROGRESS";
}

/** The automatic retries of a LOCK_UNAVAILABLE completion before the driver is told (same key every time). */
export const LOCK_RETRY_DELAYS_MS = [1000, 2000] as const;
