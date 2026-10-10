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
  /** True the FIRST time `key` is seen by this process: keeps a repeating condition to one log line. */
  once: (key: string) => boolean;
  /** Process-local rotation cursors of the periodic sweeps (see dunning-paging.ts); empty after a restart. */
  cursors: Map<string, string>;
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

/** Cents still owed on an invoice, from the facts (never a float). */
export function remainingCents(f: InvoiceFacts): number {
  return f.amountRemaining ?? Math.max(0, f.amountDue - f.amountPaid);
}

/**
 * "Owed" (SA-733r M2, r7 r-note 2): a Stripe invoice with status `open` and `amount_remaining > 0` - NOTHING else.
 * `uncollectible` is the owner's write-off and `void` is cancelled: neither starts, keeps or moves a clock. ONE
 * predicate shared by the stamp, the resume, the clock move and discovery. (SA-733r M8: only an invoice Stripe still
 * shows as owed may be stamped, mailed or paused over.)
 */
export function isOwed(f: InvoiceFacts): boolean {
  return f.status === "open" && remainingCents(f) > 0;
}

/** When an open invoice started to be owed: its finalization time, else its creation, else `fallback`. */
export function invoiceOwedSince(inv: any, fallback: Date): Date {
  const sec = inv?.status_transitions?.finalized_at ?? inv?.created;
  return typeof sec === "number" && sec > 0 ? new Date(sec * 1000) : fallback;
}

/** A finalized open invoice younger than this is left alone: Stripe may still be about to collect it. */
export const DISCOVERY_MIN_AGE_HOURS = 24;

/**
 * Owed AND old enough to chase: the ONE filter discovery (both phases) and the clock move share, so a sibling that
 * Stripe is still collecting never starts or takes over a clock. (The resume test uses the same filter: a just-cut
 * invoice that is still auto-collecting does not keep an old debt's tenant paused; if it fails, `payment_failed`
 * stamps it.)
 */
export function isAgedOwedInvoice(i: any, now: Date): boolean {
  return (
    isOwedInvoice(i) &&
    invoiceOwedSince(i, now).getTime() <= now.getTime() - DISCOVERY_MIN_AGE_HOURS * 3_600_000
  );
}

/** The same predicate for a row of a Stripe invoice LIST (the lists are `open`-only; a stray status never counts). */
export function isOwedInvoice(i: any): boolean {
  return (
    !!i?.id && (i.status === undefined || i.status === "open") && (i.amount_remaining ?? 0) > 0
  );
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
