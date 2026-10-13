import type { Prisma } from "@prisma/client";

/**
 * SA-775: the SELECTION predicates of the automatic lock jobs, in ONE place. Each cron scans with the
 * builder below, and the super-admin unpause preview (`AutoLockAdminService.wouldLockNow`) scans with the
 * very same builder plus a `class: PRODUCTION` narrowing - so "what the crons would lock within the hour" can
 * never drift from what the crons actually select (L-167). Read-only: builders return `where` objects only.
 */

/** Days past a subscription's `periodEnd` before `suspendOverdueTenants` asks Stripe whether it was cancelled. */
export const PAYMENT_GRACE_DAYS = 3;

/** `Tenant` filter the preview adds on top of a cron's own scan. */
export type TenantNarrow = Prisma.TenantWhereInput;

/** `billing-cron.expireTrials`: a TRIAL past `trialEndsAt`. */
export const expiredTrialWhere = (
  now: Date,
  narrow: TenantNarrow = {},
): Prisma.TenantWhereInput => ({
  ...narrow,
  status: "TRIAL",
  trialEndsAt: { lt: now },
  deletedAt: null,
});

/** `billing-cron.applyScheduledCancellations`: an ACTIVE tenant whose armed cancellation reached its period end. */
export const scheduledCancellationWhere = (
  now: Date,
  narrow: TenantNarrow = {},
): Prisma.TenantSubscriptionWhereInput => ({
  cancelAtPeriodEnd: true,
  periodEnd: { not: null, lt: now },
  tenant: { ...narrow, status: "ACTIVE", deletedAt: null },
});

/** The instant before which an ACTIVE Stripe subscription's `periodEnd` counts as overdue. */
export const overdueGraceDeadline = (now: Date): Date =>
  new Date(now.getTime() - PAYMENT_GRACE_DAYS * 24 * 60 * 60 * 1000);

/**
 * `billing.suspendOverdueTenants`: an ACTIVE tenant whose Stripe subscription ended its period + grace ago.
 * The job still asks Stripe and writes only for `canceled`, so these are candidates, not certainties.
 */
export const overdueSubscriptionWhere = (
  graceDeadline: Date,
  narrow: TenantNarrow = {},
): Prisma.TenantSubscriptionWhereInput => ({
  periodEnd: { lt: graceDeadline },
  stripeSubId: { not: null },
  tenant: { ...narrow, status: "ACTIVE", deletedAt: null },
});

/** `billing.dunningSweep`: every Stripe-billed, auto-pay row that carries an owed-invoice clock. */
export const DUNNING_SWEEP_WHERE = {
  pastDueInvoiceId: { not: null },
  stripeSubId: { not: null },
  externalPayment: false,
  catchupState: null, // r3 N2(a): the sweep and the pause skip a held catch-up claim
  tenant: { deletedAt: null },
} satisfies Prisma.TenantSubscriptionWhereInput;

/** The dunning rows the pause WOULD act on once `pauseHours` have passed (preview, `enforced` mode only). */
export const dunningPauseDueWhere = (
  now: Date,
  pauseHours: number,
  narrow: TenantNarrow = {},
): Prisma.TenantSubscriptionWhereInput => ({
  ...DUNNING_SWEEP_WHERE,
  pausedAt: null,
  pastDueSince: { lte: new Date(now.getTime() - pauseHours * 60 * 60 * 1000) },
  tenant: { ...narrow, deletedAt: null, status: "ACTIVE" },
});
