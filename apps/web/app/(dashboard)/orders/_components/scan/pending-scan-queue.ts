/**
 * The poor-signal queue (scanner-redesign-spec.md §5.4, LANE-S step 7): pure state for scans whose
 * lookup failed because of CONNECTIVITY (no response at all), so a few seconds of bad signal at a
 * counter costs the operator a retry, not a re-scan. It is a bridge, not an offline mode:
 * bounded in depth and attempts, exponential backoff, and it lives only for one scan session.
 *
 * Deliberately NOT part of the order: a queued scan is a code that has not resolved to a product,
 * so it can never become a line, be priced, or be submitted until it does. (The spec sketched a
 * placeholder row inside `lineItems`; keeping the queue beside the order removes any way for an
 * unresolved scan to reach the payload.)
 *
 * All functions are pure and return new values — no clock, no storage, no randomness — so the
 * whole policy is unit-tested in plain Jest.
 */

export interface PendingScan {
  /** Caller-supplied unique id (a counter in the screen). */
  id: string;
  code: string;
  scannedAt: number;
  /** Lookups tried so far, counting the original failed one. */
  attempts: number;
  nextAttemptAt: number;
}

/** At most this many scans wait at once (more is a sign the operator should stop and reconnect). */
export const PENDING_MAX = 20;
/** Give up on a code after this many failed lookups in total. */
export const PENDING_MAX_ATTEMPTS = 10;
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_CAP_MS = 60_000;

/** Delay before the next try after `attempts` failures: 5s, 10s, 20s, 40s, then 60s. */
export function backoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (n - 1));
}

/**
 * Queue a scan whose first lookup just failed (that failure is attempt 1). Two scans of the same
 * code are two deliberate scans (the gate already accepted both), so nothing is deduplicated.
 * `accepted` is false when the queue is full — the caller must tell the operator.
 */
export function enqueue(
  queue: readonly PendingScan[],
  code: string,
  now: number,
  id: string,
): { queue: PendingScan[]; accepted: boolean } {
  if (queue.length >= PENDING_MAX) return { queue: [...queue], accepted: false };
  const item: PendingScan = {
    id,
    code,
    scannedAt: now,
    attempts: 1,
    nextAttemptAt: now + backoffMs(1),
  };
  return { queue: [...queue, item], accepted: true };
}

/** Scans whose retry time has arrived, oldest first. */
export function dueScans(queue: readonly PendingScan[], now: number): PendingScan[] {
  return queue.filter((p) => p.nextAttemptAt <= now);
}

/**
 * A retry failed again. Bumps the attempt count and schedules the next try with backoff; at
 * `PENDING_MAX_ATTEMPTS` the scan is DROPPED and returned so the caller can say so. An unknown id
 * is a no-op (the operator discarded it while the lookup was in flight).
 */
export function recordFailure(
  queue: readonly PendingScan[],
  id: string,
  now: number,
): { queue: PendingScan[]; dropped: PendingScan | null } {
  const target = queue.find((p) => p.id === id);
  if (!target) return { queue: [...queue], dropped: null };
  const attempts = target.attempts + 1;
  if (attempts >= PENDING_MAX_ATTEMPTS) {
    return { queue: queue.filter((p) => p.id !== id), dropped: { ...target, attempts } };
  }
  return {
    queue: queue.map((p) =>
      p.id === id ? { ...p, attempts, nextAttemptAt: now + backoffMs(attempts) } : p,
    ),
    dropped: null,
  };
}

export function removePending(queue: readonly PendingScan[], id: string): PendingScan[] {
  return queue.filter((p) => p.id !== id);
}

/** Make every waiting scan due now ("Retry now", or the browser reporting it is back online). */
export function retryAllNow(queue: readonly PendingScan[], now: number): PendingScan[] {
  return queue.map((p) => ({ ...p, nextAttemptAt: Math.min(p.nextAttemptAt, now) }));
}
