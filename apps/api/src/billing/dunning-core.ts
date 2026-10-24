import type { Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import type { BillingNotificationService } from "./billing-notification.service";
import type { BillingEventType } from "./plan-catalog.constants";
import type { InvoiceFacts } from "./catchup-claim";
import { type BillingPauseMode, PAYMENT_OVERDUE_REASON, READ_ONLY_STATUS } from "./dunning-config";
import type { PauseExit } from "./transition-to-active";
import type { StripeService } from "./stripe.service";
import type { AutoLockSwitch } from "./auto-lock-gate";

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
  /** SA-775: the rollout pause on AUTOMATIC locks; the pause asks it before it writes (undefined = a bare unit spec). */
  autoLocks?: AutoLockSwitch;
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
 * "Owed" (SA-733r M2, r7 r-notes 2 and 4): a Stripe invoice with status `open` and `amount_remaining > 0` - NOTHING
 * else. `uncollectible` is the owner's write-off and `void` is cancelled: neither starts, keeps or moves a clock.
 * This is the rule for an invoice whose FACTS we hold (the clocked invoice, a stamp, the 409 guard): it is never
 * age-filtered. (SA-733r M8: only an invoice Stripe still shows as owed may be stamped, mailed or paused over.)
 */
export function isOwed(f: InvoiceFacts): boolean {
  return f.status === "open" && remainingCents(f) > 0;
}

/** When an open invoice started to be owed: its finalization time, else its creation, else `fallback`. */
export function invoiceOwedSince(inv: any, fallback: Date): Date {
  const sec = inv?.status_transitions?.finalized_at ?? inv?.created;
  return typeof sec === "number" && sec > 0 ? new Date(sec * 1000) : fallback;
}

/** A finalized open invoice younger than this, and never attempted, is left alone: Stripe may still collect it. */
const OWED_MIN_AGE_HOURS = 24;

/**
 * The ONE owed rule for a row of a Stripe invoice LIST (SA r-note 4): status `open` AND `amount_remaining > 0` AND
 * (older than 24 h OR Stripe already attempted it). Resume (is a sibling still owed?), the clock move, discovery
 * (stamp) and discovery's phase-2 move/clear all call this and nothing else. A young invoice Stripe has not yet
 * tried is not owed YET (if its collection fails, `payment_failed` stamps it); one it HAS tried is.
 *
 * The CLOCKED invoice itself is never age-filtered: pass its id as `clockedId` (it is already being chased, so a
 * 2-hour-old clocked invoice must not read as "gone" because a sibling was paid). Lists are `open`-only; a stray
 * status never counts.
 */
export function isOwedInvoice(i: any, now: Date, clockedId?: string | null): boolean {
  if (!i?.id) return false;
  if (i.status !== undefined && i.status !== "open") return false;
  if (!((i.amount_remaining ?? 0) > 0)) return false;
  if (clockedId && i.id === clockedId) return true;
  if ((i.attempt_count ?? 0) > 0) return true;
  return invoiceOwedSince(i, now).getTime() <= now.getTime() - OWED_MIN_AGE_HOURS * 3_600_000;
}

/** A tenant that is paused for non-payment (local `pausedAt`, or READ_ONLY with the `payment_overdue` reason). */
export function isPausedRow(row: Pick<DunningRow, "pausedAt" | "tenant">): boolean {
  return (
    !!row.pausedAt ||
    (row.tenant.status === READ_ONLY_STATUS && row.tenant.readOnlyReason === PAYMENT_OVERDUE_REASON)
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
