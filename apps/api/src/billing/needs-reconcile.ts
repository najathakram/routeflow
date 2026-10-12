import type { Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { AdminAuditAction } from "../platform-admin/audit-actions.constant";
import type { PrismaService } from "../prisma/prisma.service";
import { lockTenantForLedger } from "./addon-ledger";
import { writeAdminNotice } from "./manual-invoice-notice";

/**
 * SA-733r [M7] / SA-733r3 [N4]: `TenantSubscription.needsReconcile` - "Stripe may be AHEAD of the local row and
 * a human (or the reconciler) has to look".
 *
 *   - {@link armNeedsReconcile}   BEFORE a Stripe write whose local half follows: sets the flag under the Tenant
 *     lock and writes the attempt's audit row (idempotency key + attempt nonce) in the SAME transaction, so a
 *     process that dies between Stripe's reply and the local commit leaves both the flag and the key to find.
 *     If it cannot be written the caller MUST NOT call Stripe.
 *   - {@link clearNeedsReconcile} AFTER the local half succeeded (or the Stripe write was verifiably not applied
 *     / was reverted). It clears only a flag THIS attempt armed (`owned`): a flag some other unresolved
 *     inconsistency set stays up.
 *   - {@link markNeedsReconcile}  a Stripe write that could not be undone or confirmed: keeps the ERROR-level
 *     alert and (best effort) raises the flag. Never cleared by the flow that raised it.
 *
 * Lock order: Tenant row first (`lockTenantForLedger`), the same as every other subscription writer.
 */

export type ReconcilePrisma = Pick<PrismaService, "$transaction">;

export interface ReconcileDeps {
  /** Absent in a spec / script without a database: the alert is log-only and arm/clear are no-ops. */
  prisma?: ReconcilePrisma | null;
  logger: Pick<Logger, "error" | "warn">;
}

export interface NeedsReconcileInfo {
  tenantId: string;
  stripeSubId?: string;
  /** The idempotency key of the push that Stripe applied. */
  key?: string;
  /** What the local row holds (it is NOT where Stripe now is). */
  local?: unknown;
  /** What Stripe now holds after the forward push (the intended state) and what the revert tried to restore. */
  stripe?: unknown;
  error?: unknown;
}

export interface ArmArgs {
  tenantId: string;
  /** Which flow armed it: "plan_change" | "price_override" ... (audit meta only). */
  kind: string;
  /** The Stripe idempotency key of the write about to be sent. */
  key: string;
  /** The attempt nonce embedded in the key (a fresh uuid per attempt). */
  nonce?: string;
  stripeSubId?: string;
  actorId?: string | null;
}

/** What `arm` reports: whether THIS attempt raised the flag (and so may clear it). */
export interface Armed {
  owned: boolean;
}

export const NEEDS_RECONCILE_ARMED_KIND = "needs_reconcile_armed";

export async function armNeedsReconcile(deps: ReconcileDeps, a: ArmArgs): Promise<Armed> {
  if (!deps.prisma) return { owned: false };
  return deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await lockTenantForLedger(tx, a.tenantId);
    // owned = the flag went false -> true here. updateMany's count is the answer, atomically.
    const raised = await tx.tenantSubscription.updateMany({
      where: { tenantId: a.tenantId, needsReconcile: false },
      data: { needsReconcile: true },
    });
    await writeAdminNotice(tx, {
      tenantId: a.tenantId,
      actorId: a.actorId,
      action: AdminAuditAction.TENANT_CONFIG_UPDATED,
      message: `A ${a.kind} is about to be sent to Stripe; the subscription is flagged for reconcile until its local write lands.`,
      meta: {
        kind: NEEDS_RECONCILE_ARMED_KIND,
        flow: a.kind,
        idempotencyKey: a.key,
        attemptNonce: a.nonce ?? null,
        stripeSubId: a.stripeSubId ?? null,
        alreadyFlagged: raised.count === 0,
      },
    });
    return { owned: raised.count === 1 };
  });
}

/**
 * Clear the flag an attempt armed. Best effort: a failure here only leaves the flag up (the safe direction) and is
 * logged - it must never turn a successful plan change into an error.
 */
export async function clearNeedsReconcile(
  deps: ReconcileDeps,
  tenantId: string,
  armed: Armed | boolean | undefined,
): Promise<void> {
  const owned = typeof armed === "object" ? armed.owned : armed === true;
  if (!deps.prisma || !owned) return;
  try {
    await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await lockTenantForLedger(tx, tenantId);
      await tx.tenantSubscription.updateMany({
        where: { tenantId, needsReconcile: true },
        data: { needsReconcile: false },
      });
    });
  } catch (err) {
    deps.logger.warn(
      `billing.needs_reconcile.clear_failed tenant=${tenantId}: ${(err as Error).message} - the flag stays up`,
    );
  }
}

export async function markNeedsReconcile(
  deps: ReconcileDeps,
  info: NeedsReconcileInfo,
): Promise<void> {
  deps.logger.error(
    `billing.plan_change.needs_reconcile ${JSON.stringify({
      event: "billing.plan_change.needs_reconcile",
      severity: "ERROR",
      tenantId: info.tenantId,
      stripeSubId: info.stripeSubId ?? null,
      idempotencyKey: info.key ?? null,
      localState: info.local ?? null,
      stripeState: info.stripe ?? null,
      error: info.error instanceof Error ? info.error.message : (info.error ?? null),
    })}`,
  );
  if (!deps.prisma) return;
  try {
    await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await lockTenantForLedger(tx, info.tenantId);
      await tx.tenantSubscription.updateMany({
        where: { tenantId: info.tenantId },
        data: { needsReconcile: true },
      });
    });
  } catch (err) {
    // The alert above is the record; a database that cannot take the flag is already a bigger problem.
    deps.logger.error(
      `billing.needs_reconcile.flag_failed tenant=${info.tenantId}: ${(err as Error).message}`,
    );
  }
}
