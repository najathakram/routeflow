import { roundMoney, toCents } from "@routeflow/pricing";
import { prorateDaily } from "./billing-math";
import { nextCheckoutAnchor } from "./checkout-anchor";
import {
  BOUNDARY_HOUR_UTC,
  boundary,
  paidThrough as sharedPaidThrough,
  snapToBoundary,
} from "./rf-invoice/calendar-windows";

/**
 * SA-733 D7 / SA-733r [M5] / r2 / r3 [N3] / r4 / r5: the October CATCH-UP of a manually-invoiced tenant, as a
 * PURE plan. No Stripe, no database, no clock of its own. The caller supplies the tenant's resolved monthly price
 * (the one rule in plan-price.ts: override beats catalog), its billable add-ons and its RfInvoices.
 *
 *   paid-through   snap(last periodEnd) of the contiguous run of PAID RfInvoices (r4a), via the ONE shared helper
 *                  (rf-invoice/calendar-windows.ts: boundary, snap, contiguity, paidThrough - L-167); with none,
 *                  the go-live boundary (Oct 1 12:00Z). A PAID invoice AFTER a gap is NEEDS RULING (r2).
 *   unpaid span    [paid-through, A) - monthly price (+ billable add-ons) x unpaid days / days in month, month by
 *                  month (fractional days allowed, boundary = the 1st at 12:00Z).
 *   shape          SA-733r5: which Checkout parameters carry it, given Stripe's documented Checkout limits
 *                  ("a one-time price cannot sit beside proration_behavior none"; "a trial cannot be combined with
 *                  a billing cycle anchor"). See {@link CheckoutShape} and {@link catchupShape}.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The go-live boundary: billing starts Oct 1 (owner ruling), at the 12:00Z boundary every window uses. */
export const CATCHUP_GO_LIVE = boundary(2026, 9);

/** A trial must end at least 48 h out (Stripe); 72 h keeps the floor even if the session completes at its 24 h expiry. */
export const CATCHUP_TRIAL_MIN_LEAD_MS = 72 * 60 * 60 * 1000;

/** Stripe's smallest chargeable amount in USD (r3 N3: "the stub is skipped under $0.50"). */
export const STRIPE_MIN_CHARGE_CENTS = 50;

/** The first 1st-12:00Z boundary at or AFTER `d` (exact: no snapping - used for "at least 72 h from now"). */
export function firstBoundaryNotBefore(d: Date): Date {
  const c = boundary(d.getUTCFullYear(), d.getUTCMonth());
  return c.getTime() >= d.getTime() ? c : boundary(d.getUTCFullYear(), d.getUTCMonth() + 1);
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
 * Paid-through = the shared `paidThrough` walked forward from the FLOOR over the PAID invoices; the floor is the
 * go-live boundary, or the tenant's billing start when that is later (a tenant activated after go-live is not
 * charged from Oct 1). A PAID invoice the walk could not reach (after a gap) refuses: NEEDS RULING, never a guess.
 */
export function paidThroughOf(
  invoices: readonly CatchupInvoice[],
  floor: Date = CATCHUP_GO_LIVE,
): PaidThrough {
  const paid = invoices.filter((i) => i.status === "PAID");
  if (paid.some((i) => !i.periodStart || !i.periodEnd)) {
    return { ok: false, reason: "paid_invoice_without_period" };
  }
  if (paid.length === 0) {
    return { ok: true, paidThrough: floor, paidInvoiceIds: [], fromInvoices: false };
  }
  const windows = paid.map((i) => ({ periodStart: i.periodStart!, periodEnd: i.periodEnd! }));
  const reached = sharedPaidThrough(windows, floor) ?? floor;
  // a PAID period that ends after the run (it started after a gap) was not walked: NEEDS RULING
  const outside = paid.filter((i) => snapToBoundary(i.periodEnd!).getTime() > reached.getTime());
  if (outside.length > 0) return { ok: false, reason: "paid_after_gap" };
  return {
    ok: true,
    paidThrough: reached,
    paidInvoiceIds: paid
      .filter((i) => snapToBoundary(i.periodEnd!).getTime() > floor.getTime())
      .map((i) => i.id),
    fromInvoices: true,
  };
}

export interface CatchupAddon {
  sku: string;
  /** Monthly price of ONE unit, dollars (the row's snapshot). */
  unitPrice: number;
  quantity: number;
}

/**
 * A priced, billable add-on ROW the tenant holds today (what the manual RfInvoice bills: every billable active row at
 * its snapshot x quantity - rf-invoice-builder). `unitPrice` is the row's snapshot in dollars, null when unpriced.
 */
export interface CatchupAddonRow {
  code: string;
  quantity: number;
  unitPrice: number | null;
}

/**
 * Money (MF1). The card subscription bills ONLY the checkout add-on lines (self-serve SKUs at the CATALOG price,
 * oldest row's quantity); the settlement then voids WHOLE RfInvoices. A priced billable row with no checkout line (a
 * platform-admin-only SKU) would be billed on the invoice, voided, and never billed again - so the plan refuses:
 *   - "billable_addon_not_card_billable"  a priced billable row has no checkout line;
 *   - "addon_snapshot_not_catalog"        its snapshot (or its quantity across duplicate rows) is not what the
 *                                          checkout line will bill;
 *   - "checkout_addon_without_priced_row" (the reverse) a checkout line has no priced billable row behind it.
 * Unpriced rows (snapshot null / 0) and zero quantities bill nothing on the invoice either, so they never refuse.
 */
export function addonCardRefusal(
  rows: readonly CatchupAddonRow[],
  lines: readonly CatchupAddon[],
):
  | "billable_addon_not_card_billable"
  | "addon_snapshot_not_catalog"
  | "checkout_addon_without_priced_row"
  | null {
  const byCode = new Map<string, { quantity: number; prices: Set<number> }>();
  for (const r of rows) {
    if (!(r.unitPrice != null && r.unitPrice > 0) || !(r.quantity >= 1)) continue;
    const cur = byCode.get(r.code) ?? { quantity: 0, prices: new Set<number>() };
    cur.quantity += r.quantity;
    cur.prices.add(toCents(r.unitPrice));
    byCode.set(r.code, cur);
  }
  let snapshotMismatch = false;
  for (const [code, row] of byCode) {
    const line = lines.find((l) => l.sku === code);
    if (!line) return "billable_addon_not_card_billable";
    if (
      row.prices.size !== 1 ||
      !row.prices.has(toCents(line.unitPrice)) ||
      row.quantity !== line.quantity
    ) {
      snapshotMismatch = true;
    }
  }
  if (snapshotMismatch) return "addon_snapshot_not_catalog";
  // The reverse: a checkout line for a SKU with no priced billable row. The invoice never billed it, so the card
  // would charge NEW money (an unpriced / zero-priced row bills nothing on the invoice either).
  if (lines.some((l) => !byCode.has(l.sku))) return "checkout_addon_without_priced_row";
  return null;
}

/**
 * Is [from, to) COVERED by the union of the (snapped) OPEN / PAID RfInvoice windows? Half-open intervals, merged when
 * they touch or overlap; a gap, or an uncovered head or tail, is NOT covered. Empty or inverted target = covered.
 */
export function windowsCover(invoices: readonly CatchupInvoice[], from: Date, to: Date): boolean {
  const lo = from.getTime();
  const hi = to.getTime();
  if (hi <= lo) return true;
  const windows = invoices
    .filter((x) => (x.status === "OPEN" || x.status === "PAID") && x.periodStart && x.periodEnd)
    .map((x) => [snapToBoundary(x.periodStart!).getTime(), snapToBoundary(x.periodEnd!).getTime()])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let reach = lo; // everything in [lo, reach) is covered so far
  for (const [a, b] of windows) {
    if (a > reach) break; // a hole before this window: [reach, a) is uncovered
    if (b > reach) reach = b;
    if (reach >= hi) return true;
  }
  return reach >= hi;
}

/**
 * Money (MF2). The paid-through is built from PAID RfInvoices only, but staff also record a payment by
 * (re)activating the manual subscription - which moves the period and writes no RfInvoice. Charging October again
 * on top of that is a double charge, so the plan refuses ("manual_period_ahead") when
 *   - the LATEST manual activation / renewal is AFTER go-live AND later than the FIRST one (a payment may have been
 *     recorded since; a tenant activated once, after go-live, is the separate "activated_after_go_live" case and is
 *     not double-reported here), or
 *   - [paid-through, snapped period end) is not COVERED by the union of the snapped OPEN / PAID invoice windows. A
 *     period that is just an unpaid current invoice is the normal case and is covered. Comparing only the END dates
 *     misses a pre-go-live activation whose 30 days run past Oct 1 (activated Sep 26 -> [Sep 26, Oct 26)): once the
 *     next window [Oct 26, Nov 1) is issued the END is "covered", yet Oct 1-26 was already paid by the activation.
 */
export function manualPeriodAhead(i: {
  latestMarkerAt: Date | null | undefined;
  firstMarkerAt?: Date | null;
  periodEnd: Date | null | undefined;
  paidThrough: Date;
  invoices: readonly CatchupInvoice[];
}): boolean {
  if (
    i.latestMarkerAt &&
    i.latestMarkerAt.getTime() > CATCHUP_GO_LIVE.getTime() &&
    (!i.firstMarkerAt || i.latestMarkerAt.getTime() > i.firstMarkerAt.getTime())
  ) {
    return true;
  }
  if (!i.periodEnd) return false;
  return !windowsCover(i.invoices, i.paidThrough, snapToBoundary(i.periodEnd));
}

/** A manual activation writes its marker (in the tx) and its trail row (after the commit) seconds apart. */
const ACTIVATION_CLUSTER_GAP_MS = 10 * 60 * 1000;

/**
 * The tenant's activation history as INSTANTS: rows closer than ACTIVATION_CLUSTER_GAP_MS are the same activation
 * (its marker row + trail row). `first` is the earliest activation, `latest` the START of the last one - so a
 * single activation has first === latest, and only a genuine second one (a renewal) moves `latest` past `first`.
 */
export function activationInstants(times: readonly Date[]): {
  first: Date | null;
  latest: Date | null;
} {
  if (times.length === 0) return { first: null, latest: null };
  const sorted = [...times].sort((a, b) => a.getTime() - b.getTime());
  let clusterStart = sorted[0];
  let prev = sorted[0];
  for (const t of sorted) {
    if (t.getTime() - prev.getTime() > ACTIVATION_CLUSTER_GAP_MS) clusterStart = t;
    prev = t;
  }
  return { first: sorted[0], latest: clusterStart };
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
  const snapped = snapToBoundary(from);
  const startsOnBoundary =
    snapped.getUTCDate() === 1 &&
    snapped.getUTCHours() === BOUNDARY_HOUR_UTC &&
    snapped.getUTCMinutes() === 0;
  const first = startsOnBoundary ? snapped : from;
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
 * Which Checkout parameters carry the catch-up (SA-733r5). Every shape is one Stripe documents as valid in Checkout;
 * the two invalid pairings (a one-time line with `proration_behavior`, `trial_end` with `billing_cycle_anchor`) are
 * never built (catchup-session-params.ts asserts it on everything it returns).
 *
 *  - `trial_one_time` the COMMON case, paid-through <= now (an unpaid October): `trial_end = A` alone (A = the
 *                     first 1st at 12:00Z that is >= now + 72 h) + the recurring lines + ONE one-time line = the
 *                     unpaid [paid-through, A). Stripe charges the line at completion; the cycle starts at A.
 *  - `trial`          prepaid (R16-3), T (the first boundary on/after paid-through) >= now + 72 h: `trial_end = T`
 *                     alone; the stub [paid-through, T) is a post-completion draft invoice (nothing when T itself).
 *  - `anchor_no_line` prepaid, T under 72 h away and nothing to bill before the anchor: anchor + `none`, no
 *                     one-time line.
 */
export type CheckoutShape = "trial_one_time" | "trial" | "anchor_no_line";

/** The selector (SA-733r5): `trial_one_time` iff snap(paid-through) <= now; else `trial` iff T >= now + 72 h. */
export function catchupShape(i: { paidThrough: Date; now: Date }): CheckoutShape {
  if (snapToBoundary(i.paidThrough).getTime() <= i.now.getTime()) return "trial_one_time";
  const t = firstBoundaryNotBefore(i.paidThrough);
  return t.getTime() - i.now.getTime() >= CATCHUP_TRIAL_MIN_LEAD_MS ? "trial" : "anchor_no_line";
}

export interface CatchupPlan {
  ok: true;
  now: Date;
  paidThrough: Date;
  paidFromInvoices: boolean;
  /** The next 1st (12:00Z) under the 90-minute rule (the anchor_no_line anchor). */
  anchorAt: Date;
  /**
   * The trial end the session sends: A for `trial_one_time`, T for `trial`; for `anchor_no_line` T is shown for
   * reference (no trial is sent).
   */
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
  /**
   * OPEN RfInvoices superseded at settlement: every one whose (snapped) period END is after paid-through - the card
   * subscription bills from paid-through on, so such an invoice would be a second charge (SA-744r2 / b2b review).
   */
  voidInvoiceIds: string[];
  /** OPEN RfInvoices whose period cannot be placed: left alone, reported. */
  unplaceableOpenIds: string[];
  notes: string[];
}

/** Why a plan cannot be made. Internal reason values only: a client or admin sees the mapped coded refusal. */
export type CatchupPlanRefusal =
  | "paid_after_gap"
  | "paid_invoice_without_period"
  | "no_monthly_price"
  | "billable_addon_not_card_billable"
  | "addon_snapshot_not_catalog"
  | "checkout_addon_without_priced_row"
  | "manual_period_ahead";

export type CatchupPlanResult = CatchupPlan | { ok: false; reason: CatchupPlanRefusal };

/** The OPEN RfInvoice ids a settlement voids: period end (snapped) after paid-through. */
export function supersededOpenInvoiceIds(
  invoices: readonly CatchupInvoice[],
  paidThrough: Date,
): { void: string[]; unplaceable: string[] } {
  const open = invoices.filter((x) => x.status === "OPEN");
  return {
    void: open
      .filter((x) => x.periodEnd && snapToBoundary(x.periodEnd).getTime() > paidThrough.getTime())
      .map((x) => x.id),
    unplaceable: open.filter((x) => !x.periodEnd).map((x) => x.id),
  };
}

export function planCatchup(i: {
  now: Date;
  monthly: number | null;
  addons: readonly CatchupAddon[];
  invoices: readonly CatchupInvoice[];
  /** The tenant's billing start (first manual activation), when known; the floor is max(go-live, this). */
  billingStart?: Date | null;
  /** The tenant's priced billable add-on ROWS (MF1). Omitted = the check is skipped (pure unit tests only). */
  billableRows?: readonly CatchupAddonRow[];
  /** The manual subscription's period + its latest activation / renewal marker (MF2). Omitted = skipped. */
  manual?: { latestMarkerAt: Date | null; periodEnd: Date | null };
}): CatchupPlanResult {
  if (i.monthly == null || !(i.monthly >= 0)) return { ok: false, reason: "no_monthly_price" };
  const floor =
    i.billingStart && i.billingStart.getTime() > CATCHUP_GO_LIVE.getTime()
      ? i.billingStart
      : CATCHUP_GO_LIVE;
  const pt = paidThroughOf(i.invoices, floor);
  if (!pt.ok) return pt;
  if (i.billableRows) {
    const refusal = addonCardRefusal(i.billableRows, i.addons);
    if (refusal) return { ok: false, reason: refusal };
  }
  if (
    i.manual &&
    manualPeriodAhead({
      latestMarkerAt: i.manual.latestMarkerAt,
      firstMarkerAt: i.billingStart,
      periodEnd: i.manual.periodEnd,
      paidThrough: pt.paidThrough,
      invoices: i.invoices,
    })
  ) {
    return { ok: false, reason: "manual_period_ahead" };
  }

  const anchorAt = nextCheckoutAnchor(i.now);
  const t = firstBoundaryNotBefore(pt.paidThrough);
  const a = firstBoundaryNotBefore(new Date(i.now.getTime() + CATCHUP_TRIAL_MIN_LEAD_MS));
  const notes: string[] = [];
  let shape = catchupShape({ paidThrough: pt.paidThrough, now: i.now });

  // where the stub ends: A (>= now + 72 h) for trial_one_time, T for the prepaid trial, the anchor otherwise
  let trialEndAt = shape === "trial_one_time" ? a : t;
  let stubTo = shape === "trial_one_time" ? a : shape === "trial" ? t : anchorAt;
  let lines = stubLines(i.monthly, i.addons, pt.paidThrough, stubTo);
  let totalCents = lines.reduce((s, l) => s + l.cents, 0);

  // prepaid but a real stub before the anchor (paid through mid-month, 1-3 days from a 1st): anchor_no_line would
  // leave it unbilled, so the one-time-line shape bills it (edge case of the r5 selector)
  if (shape === "anchor_no_line" && totalCents >= STRIPE_MIN_CHARGE_CENTS) {
    shape = "trial_one_time";
    trialEndAt = a;
    stubTo = a;
    lines = stubLines(i.monthly, i.addons, pt.paidThrough, stubTo);
    totalCents = lines.reduce((s, l) => s + l.cents, 0);
    notes.push("paid through mid-month with under 72 h to the 1st: the stub rides a one-time line");
  }
  const belowStripeMinimum = totalCents > 0 && totalCents < STRIPE_MIN_CHARGE_CENTS;
  if (belowStripeMinimum) notes.push("stub is under Stripe's $0.50 minimum: it is skipped");
  if (shape === "trial_one_time" && a.getTime() > firstBoundaryNotBefore(i.now).getTime()) {
    // A moved past the next 1st: that month is paid 1-3 days early (R5-2) - the owner can veto
    notes.push(
      "R5-2: the 1st is under 72 h away, so the line includes the following month (paid 1-3 days early)",
    );
  }

  const superseded = supersededOpenInvoiceIds(i.invoices, pt.paidThrough);

  return {
    ok: true,
    now: i.now,
    paidThrough: pt.paidThrough,
    paidFromInvoices: pt.fromInvoices,
    anchorAt,
    trialEndAt,
    shape,
    stub: {
      from: pt.paidThrough,
      to: stubTo,
      label: describeStub(pt.paidThrough, stubTo),
      lines,
      totalCents,
      belowStripeMinimum,
    },
    voidInvoiceIds: superseded.void,
    unplaceableOpenIds: superseded.unplaceable,
    notes,
  };
}
