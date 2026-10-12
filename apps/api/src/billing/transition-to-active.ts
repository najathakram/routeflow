import type { Prisma } from "@prisma/client";

/**
 * SA-733r2 N5 / SA-733r7 PR-B3: the ONE path back to `Tenant.status = ACTIVE`.
 *
 * It nulls `readOnlyReason` and, in the SAME transaction, clears the dunning clock and the pause on the
 * subscription row (`pastDueSince` / `pastDueInvoiceId` / `pausedAt`), so no route out of READ_ONLY /
 * SUSPENDED / TRIAL can leave a stale clock that would re-pause a paying tenant. Every other write of
 * `status: "ACTIVE"` in billing and platform-admin goes through it (`dunning-structural.spec.ts` pins that).
 *
 * The caller holds the Tenant row lock (`lockTenantForLedger`) - the house order is Tenant, then
 * TenantSubscription - and runs the returned `exit` AFTER commit (`DunningService.clearPauseAfterCommit`):
 * a tenant that leaves `payment_overdue` must also leave Stripe's `pause_collection` (SA-733r3 F4).
 */

/** The subscription columns this helper clears: the dunning clock and the pause. */
export const DUNNING_CLEAR = {
  pastDueSince: null,
  pastDueInvoiceId: null,
  pausedAt: null,
} as const;

/** What the caller must undo on Stripe after the transaction commits. */
export interface PauseExit {
  tenantId: string;
  stripeSubId: string;
  /** When the tenant left the pause; part of the unpause idempotency key. */
  exitAt: Date;
}

export interface ToActiveOptions {
  /**
   * Extra CAS predicate on the Tenant row (e.g. `{ status: { not: "ACTIVE" } }`). A caller that passes one has already
   * restricted the write to a row that is LEAVING a non-ACTIVE state.
   */
  where?: Prisma.TenantWhereInput;
  /** Extra Tenant columns written in the same statement (plan, planVersionId, ...). */
  data?: Prisma.TenantUncheckedUpdateManyInput;
  /** The exit instant (defaults to now); injectable for deterministic keys in a spec. */
  now?: Date;
  /**
   * An explicit exit reason: clear the dunning clock + pause even when the row was ALREADY active (a manual-pay
   * activation supersedes card dunning). Without it a where-less caller on an already-ACTIVE row leaves a live clock
   * alone - `dark` must stay behaviour-neutral (Opus review).
   */
  clearDunning?: boolean;
}

/**
 * Clears the dunning clock and the pause on the subscription row (inside the caller's tx, Tenant lock held) and
 * returns the Stripe pause the caller must clear after commit - null when the row was not paused. The path back to
 * ACTIVE ({@link transitionToActiveTx}) and `extendTrial` (which writes TRIAL, SA-733r4 F4 #7) both use it.
 */
export async function clearDunningTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  now: Date = new Date(),
): Promise<PauseExit | null> {
  // Read BEFORE the clear: a row that was paused owes Stripe an unpause after the caller commits.
  const before = await tx.tenantSubscription.findUnique({
    where: { tenantId },
    select: { pausedAt: true, stripeSubId: true },
  });
  await tx.tenantSubscription.updateMany({ where: { tenantId }, data: { ...DUNNING_CLEAR } });
  return before?.pausedAt && before.stripeSubId
    ? { tenantId, stripeSubId: before.stripeSubId, exitAt: now }
    : null;
}

export async function transitionToActiveTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  opts: ToActiveOptions = {},
): Promise<{ count: number; exit: PauseExit | null }> {
  const to = { ...(opts.data ?? {}), status: "ACTIVE" as const, readOnlyReason: null };
  let count: number;
  let left: boolean; // did the row actually LEAVE a non-ACTIVE state?
  if (opts.where) {
    ({ count } = await tx.tenant.updateMany({ where: { ...opts.where, id: tenantId }, data: to }));
    left = count === 1;
  } else {
    // A where-less caller (subscribe, admin activation) may hit a row that is ALREADY active. First try the real
    // transition; when the row was already active, still write the plan columns (and null a stale reason) - but
    // that is not an exit, so the dunning clock is left alone.
    const first = await tx.tenant.updateMany({
      where: { id: tenantId, status: { not: "ACTIVE" } },
      data: to,
    });
    left = first.count === 1;
    count = first.count;
    if (!left) {
      ({ count } = await tx.tenant.updateMany({
        where: { id: tenantId, status: "ACTIVE" },
        data: { ...(opts.data ?? {}), readOnlyReason: null },
      }));
    }
  }
  if (count !== 1) return { count, exit: null };
  if (!left && !opts.clearDunning) return { count, exit: null };
  return { count, exit: await clearDunningTx(tx, tenantId, opts.now) };
}

/**
 * Local half of leaving a pause WITHOUT going back to ACTIVE (an admin moves a paused tenant to SUSPENDED /
 * CANCELLED / ...): clears `pausedAt` only - the clock and the owed marker stay, the invoice is still owed - and returns
 * the Stripe pause the caller clears after commit (null when the row was not paused). Tenant lock held by the caller.
 */
export async function releasePauseTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  now: Date = new Date(),
): Promise<PauseExit | null> {
  const sub = await tx.tenantSubscription.findUnique({
    where: { tenantId },
    select: { pausedAt: true, stripeSubId: true },
  });
  if (!sub?.pausedAt) return null;
  await tx.tenantSubscription.updateMany({ where: { tenantId }, data: { pausedAt: null } });
  return sub.stripeSubId ? { tenantId, stripeSubId: sub.stripeSubId, exitAt: now } : null;
}
