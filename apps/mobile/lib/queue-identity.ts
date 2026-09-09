/**
 * REG-B137 / D2 (`.claude/pipeline/2026-09-09-train1-driver-teardown/cause-ruling.md` §3):
 * identity-stamped offline queue. Today's drain always replays under whichever user is
 * CURRENTLY signed in, regardless of who queued the entry — on a shared device that
 * misattributes work to the wrong driver. This module partitions the queue by identity
 * BEFORE anything reaches `drainQueue` (lib/queue-drain.ts, real and unmodified):
 *
 *   - `stampQueuedAction` stamps `{ userId, tenantId }` (read from the current auth/tenant
 *     stores by the caller) onto an action at enqueue time.
 *   - `filterQueueForCurrentUser` partitions a stamped queue against the signed-in identity:
 *     entries stamped for a different user go to `mismatched` with reason "different-user"
 *     and are NEVER attempted; a legacy entry with no stamp at all is adopted for the current
 *     user this ONE time (drained, and returned in `restamped` for the caller to persist
 *     back) — once restamped it is an ordinary owned/mismatched entry on every later call.
 *   - `selectFailedActionsForUser` is the pure selector behind "failedActions listed per
 *     user" (only the signed-in user's failures are shown).
 *   - `settleQueueOwnership` is the one call the drain caller makes: it applies that
 *     partition to the real store (record + remove a different user's entry, persist an
 *     adopted legacy stamp) and hands back only what this session may replay.
 *   - `resolveQueueIdentity` reads that identity off the auth/tenant stores, lazily — see
 *     its own note on why the reads never happen at module scope.
 */
import type { QueuedAction } from "../store/offlineQueue";
import type { FailedActionRecord } from "./queue-drain";
import { useAuthStore } from "./auth-store";
import { useTenantStore } from "./tenant-store";

export interface QueueIdentity {
  userId: string;
  tenantId: string;
}

export type StampedAction = QueuedAction & Partial<QueueIdentity>;

export function stampQueuedAction(
  action: Omit<QueuedAction, "id" | "timestamp" | "retries">,
  identity: QueueIdentity,
): Omit<QueuedAction, "id" | "timestamp" | "retries"> & QueueIdentity {
  return { ...action, ...identity };
}

export interface OwnershipPartition {
  /** Entries safe to hand to `drainQueue` — the current user's own. */
  toDrain: StampedAction[];
  /** Entries stamped for a DIFFERENT user — never executed. */
  mismatched: FailedActionRecord[];
  /** Legacy unstamped entries adopted this call — persist these back. */
  restamped: StampedAction[];
}

export function filterQueueForCurrentUser(
  queue: StampedAction[],
  identity: QueueIdentity,
): OwnershipPartition {
  const toDrain: StampedAction[] = [];
  const mismatched: FailedActionRecord[] = [];
  const restamped: StampedAction[] = [];

  for (const action of queue) {
    if (action.userId === undefined) {
      // Legacy entry queued before this fix shipped — no stamp at all.
      // Adopt it for the current user this ONE time: drain it now, and hand
      // it back via `restamped` so the caller persists the stamp, after
      // which it is an ordinary owned (or mismatched) entry.
      const adopted: StampedAction = {
        ...action,
        userId: identity.userId,
        tenantId: identity.tenantId,
      };
      toDrain.push(adopted);
      restamped.push(adopted);
      continue;
    }

    if (action.userId === identity.userId) {
      toDrain.push(action);
      continue;
    }

    mismatched.push({
      action,
      reason: "different-user",
      failedAt: Date.now(),
    });
  }

  return { toDrain, mismatched, restamped };
}

export function selectFailedActionsForUser(
  failedActions: FailedActionRecord[],
  userId: string,
): FailedActionRecord[] {
  return failedActions.filter((f) => (f.action as StampedAction).userId === userId);
}

/**
 * The identity every queue write is stamped with, or `null` when nobody is
 * signed in (nothing may be stamped, and nothing may be drained — see
 * `hooks/useNetworkSync.ts`).
 *
 * The store reads are deliberately LAZY (inside this function, never at module
 * scope): `store/offlineQueue.ts` imports this module and `lib/auth-store.ts`
 * transitively imports the queue back through `lib/api-client.ts`, so a
 * load-time read would depend on module evaluation order.
 */
export function resolveQueueIdentity(): QueueIdentity | null {
  const user = useAuthStore.getState().user;
  if (!user) return null;
  // AuthUser carries no tenant today; the signed-in tenant slug is the stable
  // stand-in, and a future `tenantId` on the user wins when it appears.
  const userTenantId = (user as { tenantId?: string }).tenantId;
  return {
    userId: user.id,
    tenantId: userTenantId ?? useTenantStore.getState().slug ?? "",
  };
}

/** The queue-store writes `settleQueueOwnership` performs on the caller's behalf. */
export interface QueueOwnershipOps {
  /** Persist a record that must never be executed (the store's addFailedAction). */
  addFailedAction: (record: FailedActionRecord) => void;
  /** Drop an entry from the queue (the store's dequeue). */
  removeAction: (id: string) => void;
  /** Persist an adopted legacy entry's new stamp (the store's restampAction). */
  restampAction: (id: string, identity: QueueIdentity) => void;
}

/**
 * Partition `queue` against `identity` and apply the consequences to the store
 * before anything is replayed: an entry stamped for a DIFFERENT user is moved
 * to `failedActions` and removed from the queue (never attempted under this
 * session's token — B137), and a legacy unstamped entry adopted this call has
 * its stamp persisted. Returns exactly the entries safe to drain.
 */
export function settleQueueOwnership(
  queue: StampedAction[],
  identity: QueueIdentity,
  ops: QueueOwnershipOps,
): StampedAction[] {
  const { toDrain, mismatched, restamped } = filterQueueForCurrentUser(queue, identity);

  for (const record of mismatched) {
    ops.addFailedAction(record);
    ops.removeAction(record.action.id);
  }
  for (const entry of restamped) {
    ops.restampAction(entry.id, identity);
  }

  return toDrain;
}
