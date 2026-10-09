/**
 * SA-736r: THE ONE WRITER of `TenantSubscription.couponFull / couponId / couponEndsAt / couponSyncedAt`
 * (L-223: a structural pin in coupon-state.spec.ts greps the whole tree and allow-lists exactly this file).
 *
 * Two forms, one body (F3):
 *   - `applyCouponStateTx(tx, ...)` - the caller ALREADY holds the Tenant row `FOR UPDATE` (manual
 *     activation, `cancelFromStripe`'s reset, the checkout advisory -> Tenant path). It never opens a
 *     transaction (a nested `$transaction` would wait on its caller's lock until timeout).
 *   - `applyCouponState(...)` - the public wrapper: opens its own transaction and takes the lock (Tenant
 *     FIRST, #2551).
 * `syncCouponFromStripe` is the Stripe half: it runs BOTH Stripe calls before and outside any transaction
 * (the checkout tx budget is 6 s), then calls `applyCouponState`.
 *
 * Crossing the paying boundary books the ledger once, from the in-tx before/after (`isPayingRow` with only
 * `couponFull` differing; contribution = base + billable add-ons - discount, the same as `emitPayingDelta`).
 */
import { Prisma } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import { retryOnTxConflict } from "../common/tx-retry";
import type { PrismaService } from "../prisma/prisma.service";
import { lockTenantForLedger } from "./addon-ledger";
import { billableAddonWhere } from "./addon-row";
import type { BillingEventService } from "./billing-event.service";
import {
  NO_COUPON,
  couponFullFromPreview,
  firstCouponOfSubscription,
  type CouponState,
} from "./coupon-unbilled";
import { isPayingRow } from "./mrr.service";
import { BILLING_EVENTS } from "./plan-catalog.constants";
import type { StripeService } from "./stripe.service";

export interface ApplyCouponOptions {
  /** Why (a sync point, or a reset's cause): goes on the ledger event. */
  reason: string;
  /**
   * F4 (lost update): the instant the Stripe read STARTED. The write requires the stored
   * `couponSyncedAt` to be NULL or older, and stamps this value, so an older read that commits later is a
   * no-op. Absent for a reset, which stamps "now" (and so also defeats any read that started before it).
   */
  syncedAt?: Date;
  /** Skip the ledger: the caller books the crossing itself from its own in-tx before/after (activation). */
  bookDelta?: boolean;
  /** Only write while the row still holds this Stripe subscription (a replaced sub's sync is a no-op). */
  onlyStripeSubId?: string;
}

export interface ApplyCouponResult {
  /** The row was written. */
  applied: boolean;
  /** A newer write, another subscription or a lost CAS made this a no-op. */
  stale: boolean;
  /** The signed MRR delta booked (0 when none). */
  amountDelta: number;
}

const NOT_APPLIED: ApplyCouponResult = { applied: false, stale: false, amountDelta: 0 };
const STALE: ApplyCouponResult = { applied: false, stale: true, amountDelta: 0 };

/** The Tx form. `tenantLockHeld: true` is the caller's statement that it holds the Tenant `FOR UPDATE`. */
export async function applyCouponStateTx(
  tx: Prisma.TransactionClient,
  events: Pick<BillingEventService, "emit">,
  tenantId: string,
  state: CouponState,
  opts: ApplyCouponOptions & { tenantLockHeld: true },
): Promise<ApplyCouponResult> {
  const row = await tx.tenantSubscription.findUnique({
    where: { tenantId },
    select: {
      couponFull: true,
      couponSyncedAt: true,
      stripeSubId: true,
      planKey: true,
      basePriceSnapshot: true,
      discount: true,
      tenant: { select: { status: true, class: true, deletedAt: true } },
    },
  });
  if (!row) return NOT_APPLIED;
  const wasFull = row.couponFull === true;
  if (opts.onlyStripeSubId !== undefined && row.stripeSubId !== opts.onlyStripeSubId) return STALE;
  const t0 = opts.syncedAt;
  if (t0 && row.couponSyncedAt && row.couponSyncedAt.getTime() >= t0.getTime()) return STALE;

  const { count } = await tx.tenantSubscription.updateMany({
    where: {
      tenantId,
      couponFull: wasFull, // M1: CAS old -> new
      ...(t0 ? { OR: [{ couponSyncedAt: null }, { couponSyncedAt: { lt: t0 } }] } : {}),
    },
    data: {
      couponFull: state.full,
      couponId: state.couponId,
      couponEndsAt: state.endsAt,
      couponSyncedAt: t0 ?? new Date(),
    },
  });
  if (count === 0) return STALE;
  if (wasFull === state.full || opts.bookDelta === false) {
    return { applied: true, stale: false, amountDelta: 0 };
  }

  const wasPaying = isPayingRow(row.tenant, row.planKey, wasFull);
  const nowPaying = isPayingRow(row.tenant, row.planKey, state.full);
  if (wasPaying === nowPaying) return { applied: true, stale: false, amountDelta: 0 };

  const addons = await tx.tenantAddon.findMany({
    where: billableAddonWhere({ tenantId, active: true }),
    select: { priceSnapshot: true, quantity: true },
  });
  const addonMrr = addons.reduce(
    (s, a) => s + (a.priceSnapshot != null ? Number(a.priceSnapshot) : 0) * a.quantity,
    0,
  );
  const contribution = roundMoney(
    (row.basePriceSnapshot != null ? Number(row.basePriceSnapshot) : 0) +
      addonMrr -
      Number(row.discount ?? 0),
  );
  if (!contribution) return { applied: true, stale: false, amountDelta: 0 };
  const amountDelta = nowPaying ? contribution : -contribution;
  await events.emit(
    tenantId,
    nowPaying ? BILLING_EVENTS.COUPON_BILLED : BILLING_EVENTS.COUPON_UNBILLED,
    { source: "coupon_state", reason: opts.reason, couponId: state.couponId },
    { amountDelta, tx },
  );
  return { applied: true, stale: false, amountDelta };
}

interface WriterDeps {
  prisma: Pick<PrismaService, "$transaction">;
  events: Pick<BillingEventService, "emit">;
}

/** The public wrapper: its own transaction, the Tenant row lock FIRST. */
export function applyCouponState(
  deps: WriterDeps,
  tenantId: string,
  state: CouponState,
  opts: ApplyCouponOptions,
): Promise<ApplyCouponResult> {
  return retryOnTxConflict("billing.applyCouponState", () =>
    deps.prisma.$transaction(async (tx) => {
      await lockTenantForLedger(tx, tenantId);
      return applyCouponStateTx(tx, deps.events, tenantId, state, {
        ...opts,
        tenantLockHeld: true,
      });
    }),
  );
}

/** M5: `couponFull` never outlives its Stripe subscription - every column back to its reset value. */
export function resetCouponState(
  deps: WriterDeps,
  tenantId: string,
  reason: string,
): Promise<ApplyCouponResult> {
  return applyCouponState(deps, tenantId, NO_COUPON, { reason });
}

export type CouponSyncOutcome =
  | { outcome: "applied"; full: boolean; amountDelta: number }
  | { outcome: "stale" }
  | { outcome: "skipped"; why: "no_row" | "sub_changed" | "ended" | "no_upcoming_invoice" };

export type CouponReading =
  | { kind: "state"; state: CouponState; previewTotalZero: boolean }
  | { kind: "skipped"; why: "ended" | "no_upcoming_invoice" };

/**
 * The Stripe half, pure of any database: retrieve (discounts expanded) + the upcoming-invoice preview. Both
 * calls are capped (COUPON_SYNC_REQUEST, set inside StripeService) and any failure THROWS; only
 * `invoice_upcoming_none` (preview null) keeps the stored value. `previewTotalZero` is report-only (the
 * backfill lists subs whose next invoice totals $0 without being `couponFull`) and never decides anything.
 */
export async function readCouponStateFromStripe(
  stripe: Pick<StripeService, "retrieveSubscriptionWithDiscounts" | "previewNextInvoice">,
  stripeSubId: string,
): Promise<CouponReading> {
  const sub = await stripe.retrieveSubscriptionWithDiscounts(stripeSubId);
  // A dead subscription is not synced: the cancel path resets the columns.
  if (sub?.status === "canceled" || sub?.status === "incomplete_expired") {
    return { kind: "skipped", why: "ended" };
  }
  const preview = await stripe.previewNextInvoice(stripeSubId);
  if (preview === null) return { kind: "skipped", why: "no_upcoming_invoice" };
  return {
    kind: "state",
    state: { full: couponFullFromPreview(preview), ...firstCouponOfSubscription(sub) },
    previewTotalZero: preview?.total === 0,
  };
}

/**
 * M3: sync = retrieve + preview, never the webhook payload. Both Stripe calls run BEFORE and OUTSIDE any
 * transaction. A failure THROWS (no catch here): the webhook ledger records an error and Stripe redelivers.
 * An `externalPayment` tenant keeps its `stripeSubId` but is billed by RF invoices: forced `full = false`.
 */
export async function syncCouponFromStripe(
  deps: WriterDeps & { prisma: Pick<PrismaService, "$transaction" | "tenantSubscription"> } & {
    stripe: Pick<StripeService, "retrieveSubscriptionWithDiscounts" | "previewNextInvoice">;
  },
  tenantId: string,
  stripeSubId: string,
  reason: string,
): Promise<CouponSyncOutcome> {
  const t0 = new Date();
  const row = await deps.prisma.tenantSubscription.findUnique({
    where: { tenantId },
    select: { stripeSubId: true, externalPayment: true },
  });
  if (!row) return { outcome: "skipped", why: "no_row" };
  if (row.stripeSubId !== stripeSubId) return { outcome: "skipped", why: "sub_changed" };

  let state: CouponState;
  if (row.externalPayment) {
    state = NO_COUPON;
  } else {
    const reading = await readCouponStateFromStripe(deps.stripe, stripeSubId);
    if (reading.kind === "skipped") return { outcome: "skipped", why: reading.why };
    state = reading.state;
  }

  const r = await applyCouponState(deps, tenantId, state, {
    reason,
    syncedAt: t0,
    onlyStripeSubId: stripeSubId,
  });
  return r.applied
    ? { outcome: "applied", full: state.full, amountDelta: r.amountDelta }
    : { outcome: "stale" };
}
