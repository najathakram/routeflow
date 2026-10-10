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
  /** Extra CAS predicate on the Tenant row (e.g. `{ status: { not: "ACTIVE" } }`). */
  where?: Prisma.TenantWhereInput;
  /** Extra Tenant columns written in the same statement (plan, planVersionId, ...). */
  data?: Prisma.TenantUncheckedUpdateManyInput;
  /** The exit instant (defaults to now); injectable for deterministic keys in a spec. */
  now?: Date;
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
  const { count } = await tx.tenant.updateMany({
    where: { ...(opts.where ?? {}), id: tenantId },
    data: { ...(opts.data ?? {}), status: "ACTIVE", readOnlyReason: null },
  });
  if (count !== 1) return { count, exit: null };
  return { count, exit: await clearDunningTx(tx, tenantId, opts.now) };
}
