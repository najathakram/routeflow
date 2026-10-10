import type { Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import type { BillingNotificationService } from "./billing-notification.service";
import type { BillingEventType } from "./plan-catalog.constants";
import type { InvoiceFacts } from "./catchup-claim";
import type { BillingPauseMode, READ_ONLY_STATUS } from "./dunning-config";
import type { PauseExit } from "./transition-to-active";
import type { StripeService } from "./stripe.service";

/**
 * SA-733r7 PR-B3: the shared vocabulary of the dunning modules (`dunning.service.ts`, `dunning-pause.ts`,
 * `dunning-milestones.ts`, `dunning-resolve.ts`). Types and tiny pure helpers only - no I/O here.
 */

/** Options of `BillingService.transitionAndEmit` that the dunning modules rely on. */
export interface TransitionOpts {
  /** Run inside the caller's transaction (the caller holds the Tenant row lock) instead of opening one. */
  tx?: Prisma.TransactionClient;
  /** Extra Tenant columns written by the same CAS (the pause writes `readOnlyReason: payment_overdue`). */
  data?: Prisma.TenantUncheckedUpdateManyInput;
  /** Back to ACTIVE: receives the pause the caller must clear on Stripe after commit (no auto-clear). */
  onExit?: (exit: PauseExit | null) => void;
}

/**
 * `BillingService.transitionAndEmit`: the CAS status change that books the MRR delta once. Dunning calls it through
 * this type (bound by `DunningService.bindTransition`) so MRR has exactly one writer and there is no module cycle.
 */
export type StatusTransition = (
  tenantId: string,
  statusWhere: Prisma.TenantWhereInput,
  toStatus: "ACTIVE" | typeof READ_ONLY_STATUS,
  direction: 1 | -1,
  event: BillingEventType,
  payload: Prisma.InputJsonValue,
  opts?: TransitionOpts,
) => Promise<boolean>;

export interface DunningDeps {
  prisma: PrismaService;
  stripe: StripeService;
  notifications: BillingNotificationService;
  logger: Pick<Logger, "log" | "warn" | "error" | "debug">;
  transition: StatusTransition;
  mode: () => BillingPauseMode;
}

/** The subscription + tenant columns every dunning decision reads. */
export const DUNNING_ROW_SELECT = {
  tenantId: true,
  stripeSubId: true,
  externalPayment: true,
  catchupState: true,
  pastDueSince: true,
  pastDueInvoiceId: true,
  pausedAt: true,
  tenant: { select: { status: true, readOnlyReason: true, deletedAt: true, class: true } },
} satisfies Prisma.TenantSubscriptionSelect;

export type DunningRow = Prisma.TenantSubscriptionGetPayload<{ select: typeof DUNNING_ROW_SELECT }>;

/** Stripe invoice statuses that still owe money (`uncollectible` stays owed, SA-733r3). */
const OWED_STATUSES = new Set(["open", "uncollectible"]);

/** Cents still owed on an invoice, from the facts (never a float). */
export function remainingCents(f: InvoiceFacts): number {
  return f.amountRemaining ?? Math.max(0, f.amountDue - f.amountPaid);
}

/** SA-733r M8: only an invoice Stripe still shows as owed may be stamped, mailed or paused over. */
export function isOwed(f: InvoiceFacts): boolean {
  return !!f.status && OWED_STATUSES.has(f.status) && remainingCents(f) > 0;
}

/** True when the dunning machinery may touch this row at all (D10: Stripe-billed, not manual-pay, no catch-up claim). */
export function dunningEligible(row: {
  stripeSubId: string | null;
  externalPayment: boolean;
  catchupState: string | null;
}): boolean {
  return !!row.stripeSubId && !row.externalPayment && !row.catchupState;
}

export function isStripeMissing(err: unknown): boolean {
  const e = err as { code?: string; statusCode?: number } | undefined;
  return e?.code === "resource_missing" || e?.statusCode === 404;
}
