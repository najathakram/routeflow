import { roundMoney, toCents } from "@routeflow/pricing";
import { prorateDaily } from "./billing-math";
import { ANCHOR_HOUR_UTC, nextCheckoutAnchor } from "./checkout-anchor";

/**
 * SA-733 D7 / SA-733r [M5] / r2 / r3 [N3] / r4: the October CATCH-UP of a manually-invoiced tenant, as a PURE
 * plan. No Stripe, no database, no clock of its own. The caller supplies the tenant's resolved monthly price (the
 * one rule in plan-price.ts: override beats catalog), its billable add-ons and its RfInvoices.
 *
 *   paid-through   snap(last periodEnd) of the contiguous run of PAID RfInvoices (r4a); with none, the go-live
 *                  boundary (Oct 1 12:00Z). A PAID invoice AFTER a gap is NEEDS RULING (r2).
 *   unpaid span    [paid-through, anchor) - monthly price (+ billable add-ons) x unpaid days / days in month,
 *                  month by month (fractional days allowed, boundary = the 1st at 12:00Z).
 *   shape          which Checkout parameters carry it - and, per Stripe's Checkout documentation, which do NOT:
 *                    - "You can't use one-time prices in Checkout Sessions when proration_behavior is none."
 *                    - "You can't use trials in Checkout Sessions with a billing cycle anchor."
 *                  so the SA-733 D7 shape (one-time October line + anchor + proration none) is NOT creatable.
 *                  See {@link CheckoutShape}.
 *
 * `duplicates billing-b2b`: the 24 h boundary snap below is the same definition as SA-744r2's `nextBillingWindow`
 * snap; it is a tiny pure helper kept HERE because that helper lives in files this slice does not edit. When both
 * land, point this at the shared one.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The go-live boundary: billing starts Oct 1 (owner ruling), at the 12:00Z boundary every window uses. */
export const CATCHUP_GO_LIVE = new Date(Date.UTC(2026, 9, 1, ANCHOR_HOUR_UTC, 0, 0, 0));

/** A trial must end at least 48 h out (Stripe); we want a 24 h cushion on top (r3 N3). */
export const CATCHUP_TRIAL_MIN_LEAD_MS = 72 * 60 * 60 * 1000;

/** Stripe's smallest chargeable amount in USD (r3 N3: "the stub is skipped under $0.50"). */
export const STRIPE_MIN_CHARGE_CENTS = 50;

/** B(y, m): the 1st of month m (0-based) at 12:00 UTC. */
export const boundary = (y: number, m: number): Date =>
  new Date(Date.UTC(y, m, 1, ANCHOR_HOUR_UTC, 0, 0, 0));

/** B(m) nearest to `d` among the boundaries around it. */
function nearestBoundary(d: Date): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const cands = [boundary(y, m - 1), boundary(y, m), boundary(y, m + 1)];
  return cands.reduce((best, c) =>
    Math.abs(c.getTime() - d.getTime()) < Math.abs(best.getTime() - d.getTime()) ? c : best,
  );
}

/** SA-744r: |d - B(m)| <= 24 h (inclusive) snaps to B(m); anything else is returned as is. */
export function snapToBoundary(d: Date): Date {
  const b = nearestBoundary(d);
  return Math.abs(b.getTime() - d.getTime()) <= DAY_MS ? b : d;
}

/** The first boundary on or after `d` (r3 N3's T for a paid-through date). */
export function firstBoundaryOnOrAfter(d: Date): Date {
  let c = boundary(d.getUTCFullYear(), d.getUTCMonth() - 1);
  while (c.getTime() < d.getTime()) c = boundary(c.getUTCFullYear(), c.getUTCMonth() + 1);
  return c;
}

/** Contiguous = the next period starts within the inclusive 24 h snap of the previous period's end (r4a). */
export function isContiguous(prevEnd: Date, nextStart: Date): boolean {
  return Math.abs(nextStart.getTime() - snapToBoundary(prevEnd).getTime()) <= DAY_MS;
}

export interface CatchupInvoice {
  id: string;
  status: string; // OPEN | PAID | VOID
  periodStart: Date | null;
  periodEnd: Date | null;
}

export type PaidThrough =
  | { ok: true; paidThrough: Date; paidInvoiceIds: string[]; fromInvoices: boolean }
  | { ok: false; reason: "paid_after_gap" | "paid_invoice_without_period" };

/**
 * Paid-through = snap(last periodEnd) of the contiguous run of PAID invoices from the first one; never before the
 * go-live boundary. A PAID invoice outside the run (after a gap) refuses: NEEDS RULING, never a guess.
 */
export function paidThroughOf(invoices: readonly CatchupInvoice[]): PaidThrough {
  const paid = invoices.filter((i) => i.status === "PAID");
  if (paid.some((i) => !i.periodStart || !i.periodEnd)) {
    return { ok: false, reason: "paid_invoice_without_period" };
  }
  const sorted = [...paid].sort((a, b) => a.periodStart!.getTime() - b.periodStart!.getTime());
  if (sorted.length === 0) {
    return { ok: true, paidThrough: CATCHUP_GO_LIVE, paidInvoiceIds: [], fromInvoices: false };
  }
  const run = [sorted[0]];
  for (const inv of sorted.slice(1)) {
    const last = run[run.length - 1];
    if (isContiguous(last.periodEnd!, inv.periodStart!)) run.push(inv);
    else break;
  }
  const outside = sorted.filter((i) => !run.includes(i));
  if (outside.length > 0) return { ok: false, reason: "paid_after_gap" };
  const runEnd = snapToBoundary(new Date(Math.max(...run.map((i) => i.periodEnd!.getTime()))));
  const paidThrough = runEnd.getTime() < CATCHUP_GO_LIVE.getTime() ? CATCHUP_GO_LIVE : runEnd;
  return { ok: true, paidThrough, paidInvoiceIds: run.map((i) => i.id), fromInvoices: true };
}

export interface CatchupAddon {
  sku: string;
  /** Monthly price of ONE unit, dollars (the row's snapshot). */
  unitPrice: number;
  quantity: number;
}

export interface StubLine {
  kind: "PLAN" | "ADDON";
  code: string;
  cents: number;
}

/**
 * monthly x unpaid days / days in month over [from, to), month by month between the 12:00Z boundaries. A whole
 * calendar month is exactly one monthly price; a partial month is `prorateDaily` (the shared rounding).
 */
export function spanFactor(from: Date, to: Date): { monthDays: number; days: number }[] {
  const segments: { monthDays: number; days: number }[] = [];
  let cursor = from;
  while (cursor.getTime() < to.getTime()) {
    let start = boundary(cursor.getUTCFullYear(), cursor.getUTCMonth());
    if (start.getTime() > cursor.getTime()) {
      start = boundary(cursor.getUTCFullYear(), cursor.getUTCMonth() - 1);
    }
    const end = boundary(start.getUTCFullYear(), start.getUTCMonth() + 1);
    const segEnd = end.getTime() < to.getTime() ? end : to;
    segments.push({
      monthDays: (end.getTime() - start.getTime()) / DAY_MS,
      days: (segEnd.getTime() - cursor.getTime()) / DAY_MS,
    });
    cursor = segEnd;
  }
  return segments;
}

export function stubLines(
  monthly: number,
  addons: readonly CatchupAddon[],
  from: Date,
  to: Date,
): StubLine[] {
  if (from.getTime() >= to.getTime()) return [];
  const segs = spanFactor(from, to);
  const price = (m: number) =>
    roundMoney(segs.reduce((s, g) => s + prorateDaily(m, g.days, g.monthDays), 0));
  const lines: StubLine[] = [
    { kind: "PLAN", code: "PLAN", cents: toCents(price(monthly)) },
    ...addons
      .filter((a) => a.quantity > 0 && a.unitPrice > 0)
      .map((a) => ({
        kind: "ADDON" as const,
        code: a.sku,
        cents: toCents(price(roundMoney(a.unitPrice * a.quantity))),
      })),
  ];
  return lines;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "Subscription — October 2026" for one whole month; a range or "(from Oct 15)" otherwise. */
export function describeStub(from: Date, to: Date): string {
  const monthOf = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  const near = nearestBoundary(from);
  const startsOnBoundary = Math.abs(near.getTime() - from.getTime()) <= DAY_MS;
  const first = startsOnBoundary ? near : from;
  // the last billed day is the one before the (snapped) end
  const last = new Date(snapToBoundary(to).getTime() - DAY_MS);
  if (
    first.getUTCFullYear() === last.getUTCFullYear() &&
    first.getUTCMonth() === last.getUTCMonth()
  ) {
    return startsOnBoundary
      ? `Subscription — ${monthOf(first)}`
      : `Subscription — ${monthOf(first)} (from ${MONTHS[from.getUTCMonth()].slice(0, 3)} ${from.getUTCDate()})`;
  }
  return `Subscription — ${monthOf(first)} to ${monthOf(last)}`;
}

/**
 * Which Checkout parameters carry the catch-up.
 *
 *  - `trial`          SA-733r3 N3 trial branch: T (the first boundary on/after paid-through) is >= 72 h out. Checkout
 *                     `subscription_data.trial_end = T` ALONE (the anchor follows the trial end; Checkout rejects an
 *                     explicit anchor beside a trial). The stub [paid-through, T) - nothing when paid-through is T
 *                     itself - is charged after completion as a one-off invoice.
 *  - `anchor_no_line` the no-trial branch with a $0 stub (prepaid up to the anchor): anchor + proration `none` and NO
 *                     one-time line, which Checkout accepts.
 *  - `needs_ruling`   the no-trial branch with a stub > $0: SA-733 D7's "one-time line + anchor + proration none".
 *                     Checkout rejects it (see the header). Nothing is created until the owner/SA picks a shape.
 */
export type CheckoutShape = "trial" | "anchor_no_line" | "needs_ruling";

export interface CatchupPlan {
  ok: true;
  now: Date;
  paidThrough: Date;
  paidFromInvoices: boolean;
  /** The next 1st (12:00Z) under the 90-minute rule. */
  anchorAt: Date;
  /** T of r3 N3: the first boundary on/after paid-through. */
  trialEndAt: Date;
  shape: CheckoutShape;
  /** The unpaid span the stub covers and what it comes to. */
  stub: {
    from: Date;
    to: Date;
    label: string;
    lines: StubLine[];
    totalCents: number;
    belowStripeMinimum: boolean;
  };
  /** OPEN RfInvoices that fall under the lock-and-void rule (period starts at/after paid-through, snap-tolerant). */
  voidInvoiceIds: string[];
  /** OPEN RfInvoices whose period cannot be placed: left alone, reported. */
  unplaceableOpenIds: string[];
  notes: string[];
}

export type CatchupPlanResult =
  | CatchupPlan
  | { ok: false; reason: "paid_after_gap" | "paid_invoice_without_period" | "no_monthly_price" };

export function planCatchup(i: {
  now: Date;
  monthly: number | null;
  addons: readonly CatchupAddon[];
  invoices: readonly CatchupInvoice[];
}): CatchupPlanResult {
  if (i.monthly == null || !(i.monthly >= 0)) return { ok: false, reason: "no_monthly_price" };
  const pt = paidThroughOf(i.invoices);
  if (!pt.ok) return pt;

  const anchorAt = nextCheckoutAnchor(i.now);
  const trialEndAt = firstBoundaryOnOrAfter(pt.paidThrough);
  const trialOk = trialEndAt.getTime() - i.now.getTime() >= CATCHUP_TRIAL_MIN_LEAD_MS;
  const notes: string[] = [];

  // The stub ends where billing hands over to the normal cycle: T in the trial branch, the anchor otherwise.
  const stubTo = trialOk ? trialEndAt : anchorAt;
  const stubFrom = pt.paidThrough;
  const lines = stubLines(i.monthly, i.addons, stubFrom, stubTo);
  const totalCents = lines.reduce((s, l) => s + l.cents, 0);
  const belowStripeMinimum = totalCents > 0 && totalCents < STRIPE_MIN_CHARGE_CENTS;
  if (belowStripeMinimum) notes.push("stub is under Stripe's $0.50 minimum: it is skipped");

  let shape: CheckoutShape;
  if (trialOk) shape = "trial";
  else if (totalCents === 0 || belowStripeMinimum) shape = "anchor_no_line";
  else shape = "needs_ruling";
  if (shape === "needs_ruling") {
    notes.push(
      "NEEDS RULING: Stripe Checkout rejects a one-time line with proration_behavior=none, and a trial beside a " +
        "billing_cycle_anchor. A trial ending at the anchor needs the anchor to be >= 72 h away.",
    );
  }

  const tol = pt.paidThrough.getTime() - DAY_MS;
  const open = i.invoices.filter((x) => x.status === "OPEN");
  const voidInvoiceIds = open
    .filter((x) => x.periodStart && x.periodStart.getTime() >= tol)
    .map((x) => x.id);
  const unplaceableOpenIds = open.filter((x) => !x.periodStart).map((x) => x.id);

  return {
    ok: true,
    now: i.now,
    paidThrough: pt.paidThrough,
    paidFromInvoices: pt.fromInvoices,
    anchorAt,
    trialEndAt,
    shape,
    stub: {
      from: stubFrom,
      to: stubTo,
      label: describeStub(stubFrom, stubTo),
      lines,
      totalCents,
      belowStripeMinimum,
    },
    voidInvoiceIds,
    unplaceableOpenIds,
    notes,
  };
}
