import { roundMoney, toCents } from "@routeflow/pricing";
import { prorateDaily } from "./billing-math";
import { boundary, snapToBoundary } from "./rf-invoice/calendar-windows";

/**
 * SA-733 D7 / r2 / r3 / r4 / r5 / SA-733r9 + r10 (row 339, the PRORATED catch-up): the catch-up of a manually-invoiced
 * tenant, as a PURE plan. No Stripe, no database, no clock of its own. The caller supplies the tenant's resolved
 * monthly price (the one rule in plan-price.ts: override beats catalog), its billable add-ons, its RfInvoices and its
 * activation markers.
 *
 *   floor          max(go-live, the billing start): the operator's billing-start override when one exists, else the
 *                  first activation's period start (SA-733r11). Nothing before it is ever billed.
 *   paid coverage  ONE walk ({@link paidCoverage}) from the floor over the union of PAID RfInvoice windows and the
 *                  non-voided activation windows, every boundary compared SNAPPED. A window after a gap: NEEDS RULING.
 *   S              snap(paid-through): the start of the one-time line. A paid-through within 24 h of a 1st becomes
 *                  that 1st (no half days); a mid-month one keeps its exact instant and the line prorates exactly.
 *   A              the first 1st at 12:00Z that is >= max(now + 72 h, S). The trial ends there; the card bills from A.
 *   line           [S, A) = monthly price (+ billable add-ons) x days / days in month, month by month. A line under
 *                  $0.50 is forgiven (audited once per session by the claim service).
 *   shape          S === A: the stub-free 8(e) `trial`; S < A: `trial_one_time` (charged at completion). Nothing else
 *                  is reachable (SA-733r9 G4).
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

/** One paid window (a PAID RfInvoice's, or a non-voided activation's): `[periodStart, periodEnd)`. */
export interface CoverageWindow {
  periodStart: Date;
  periodEnd: Date;
}

export type PaidCoverage =
  { ok: true; paidThrough: Date; reached: boolean } | { ok: false; reason: "paid_after_gap" };

/**
 * THE paid-coverage walk (SA-733r9 rule 1 / MF6). From `floor`, over the union of PAID RfInvoice windows AND activation
 * windows, every boundary compared SNAPPED (a window starts <= the current end after snapping both). It advances
 * while the next window starts at or before the current end and stops at the first gap. `paidThrough` is the end
 * reached (a window end is snapped, so a legacy 00:00Z spelling and an Oct 31 evening end read as the 1st). A window
 * that still ends after the run (it started after a gap) is NEEDS RULING: `paid_after_gap`. History that ends at or
 * before the floor never lowers it. `reached` says whether any window moved the end past the floor.
 */
export function paidCoverage(
  floor: Date,
  w: {
    paidRfWindows: readonly CoverageWindow[];
    activationWindows: readonly CoverageWindow[];
  },
): PaidCoverage {
  const all = [...w.paidRfWindows, ...w.activationWindows]
    .map((x) => ({
      start: snapToBoundary(x.periodStart).getTime(),
      end: snapToBoundary(x.periodEnd).getTime(),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = floor.getTime();
  let reached = false;
  for (const x of all) {
    if (x.end <= cursor) continue; // inside what is already covered, or before the floor
    if (x.start <= snapToBoundary(new Date(cursor)).getTime()) {
      cursor = x.end;
      reached = true;
    }
  }
  if (all.some((x) => x.end > cursor)) return { ok: false, reason: "paid_after_gap" };
  return { ok: true, paidThrough: new Date(cursor), reached };
}

export type PaidThrough =
  | { ok: true; paidThrough: Date; paidInvoiceIds: string[]; fromInvoices: boolean }
  | { ok: false; reason: "paid_after_gap" | "paid_invoice_without_period" };

/**
 * Paid-through over the PAID RfInvoices alone, from `floor` (the go-live boundary, or the billing start when later):
 * {@link paidCoverage} with no activation windows. The planner itself calls paidCoverage with both sources.
 */
export function paidThroughOf(
  invoices: readonly CatchupInvoice[],
  floor: Date = CATCHUP_GO_LIVE,
): PaidThrough {
  const paid = invoices.filter((i) => i.status === "PAID");
  if (paid.some((i) => !i.periodStart || !i.periodEnd)) {
    return { ok: false, reason: "paid_invoice_without_period" };
  }
  const cov = paidCoverage(floor, {
    paidRfWindows: paid.map((i) => ({ periodStart: i.periodStart!, periodEnd: i.periodEnd! })),
    activationWindows: [],
  });
  if (!cov.ok) return cov;
  return {
    ok: true,
    paidThrough: cov.paidThrough,
    paidInvoiceIds: cov.reached
      ? paid
          .filter((i) => snapToBoundary(i.periodEnd!).getTime() > floor.getTime())
          .map((i) => i.id)
      : [],
    fromInvoices: cov.reached,
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

/** One manual-activation audit row, as the catch-up reads it. */
export interface ActivationRecord {
  action: string;
  at: Date;
  /** The audit row id (the MARKER row's id is what a coverage VOID / RESTORE names). */
  id?: string;
  /** True on a marker whose coverage is voided by the latest VOID / RESTORE row (catchup-markers.ts). */
  voided?: boolean;
  /** The activation's OWN unsnapped period, when the row recorded it. */
  periodStart?: Date | null;
  periodEnd?: Date | null;
}

/** An activation is TWO audit rows (the in-tx marker and the post-commit trail row) seconds apart. */
const ACTIVATION_CLUSTER_GAP_MS = 10 * 60 * 1000;

/**
 * Is `d` an ANCHOR 1st: the 1st of a month at exactly 12:00:00.000Z (the boundary every window uses) or its legacy
 * 00:00:00.000Z spelling? UTC only - a local-time spelling of "midnight on the 1st" is not an anchor.
 */
export function isAnchorFirst(d: Date): boolean {
  return (
    d.getUTCDate() === 1 &&
    (d.getUTCHours() === 12 || d.getUTCHours() === 0) &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0
  );
}

export interface ActivationCluster {
  /** The cluster's period start: its recorded `periodStart`, else (an end with no start) its earliest `at`. */
  start: Date;
  end: Date;
  voided: boolean;
}

export type ActivationClusters =
  | { ok: true; clusters: ActivationCluster[]; firstStart: Date | null }
  | { ok: false; reason: "manual_marker_without_period" };

const validDate = (e: unknown): e is Date => e instanceof Date && !Number.isNaN(e.getTime());

/**
 * Activation rows grouped into ACTIVATIONS (marker + trail row, seconds apart) with the window each recorded.
 * An activation is usable when EITHER row carries a period END; an activation with none - a legacy marker from before
 * periods were recorded - cannot be measured, so the plan fails closed ("manual_marker_without_period"), unless a
 * VOID already says it paid nothing. A cluster with an end but NO start uses its earliest `at` as the start.
 * `firstStart` is the first activation's period start (voided or not: the activation still happened as an event) -
 * the floor's first-activation term (SA-733r10 nit 1, r11).
 */
export function activationClusters(rows: readonly ActivationRecord[]): ActivationClusters {
  const sorted = [...rows].sort((x, y) => x.at.getTime() - y.at.getTime());
  const groups: ActivationRecord[][] = [];
  let prev: number | null = null;
  for (const r of sorted) {
    if (prev === null || r.at.getTime() - prev > ACTIVATION_CLUSTER_GAP_MS) groups.push([r]);
    else groups[groups.length - 1].push(r);
    prev = r.at.getTime();
  }
  const clusters: ActivationCluster[] = [];
  // starts of voided activations that recorded no period at all: no window to ignore, but the activation still
  // happened as an event, so its earliest `at` still supplies the floor's first-activation term (N5)
  const eventStarts: Date[] = [];
  for (const g of groups) {
    const voided = g.some((r) => r.voided === true);
    const ends = g.map((r) => r.periodEnd).filter(validDate);
    const starts = g.map((r) => r.periodStart).filter(validDate);
    const start = starts.length ? new Date(Math.min(...starts.map((x) => x.getTime()))) : g[0].at; // sorted: the earliest `at`
    if (ends.length === 0) {
      if (voided) {
        eventStarts.push(start); // a voided activation with no period paid nothing and has no window to ignore
        continue;
      }
      return { ok: false, reason: "manual_marker_without_period" };
    }
    clusters.push({
      start,
      end: new Date(Math.max(...ends.map((e) => e.getTime()))),
      voided,
    });
  }
  const allStarts = [...clusters.map((c) => c.start), ...eventStarts];
  const firstStart = allStarts.length
    ? new Date(Math.min(...allStarts.map((x) => x.getTime())))
    : null;
  return { ok: true, clusters, firstStart };
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
        // scan-ok: money-rederive — a subscription add-on row (monthly price of one unit x count), never an order line; no case pack / unitsPerBox exists here, so no proration is lost.
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
const MON = MONTHS.map((m) => m.slice(0, 3));

/**
 * "Subscription — October 2026" for whole months from a 1st; a mid-month start is labelled with its start and its last
 * billed day: "Subscription — Nov 11 to Nov 30, 2026" (never a bare month name - SA-733r10 nit 2).
 */
export function describeStub(from: Date, to: Date): string {
  // S === A: there is no line to describe (never "December 2026 to November 2026")
  if (snapToBoundary(from).getTime() >= snapToBoundary(to).getTime()) return "No catch-up line";
  const monthOf = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  const snapped = snapToBoundary(from);
  const startsOnBoundary =
    snapped.getUTCDate() === 1 && snapped.getUTCHours() === 12 && snapped.getUTCMinutes() === 0;
  // the last billed day is the one before the (snapped) end
  const last = new Date(snapToBoundary(to).getTime() - DAY_MS);
  if (startsOnBoundary) {
    return snapped.getUTCFullYear() === last.getUTCFullYear() &&
      snapped.getUTCMonth() === last.getUTCMonth()
      ? `Subscription — ${monthOf(snapped)}`
      : `Subscription — ${monthOf(snapped)} to ${monthOf(last)}`;
  }
  const day = (d: Date) => `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`;
  const startLabel =
    from.getUTCFullYear() === last.getUTCFullYear()
      ? day(from)
      : `${day(from)}, ${from.getUTCFullYear()}`;
  return `Subscription — ${startLabel} to ${day(last)}, ${last.getUTCFullYear()}`;
}

/**
 * Which Checkout parameters carry the catch-up. Only two shapes are reachable (SA-733r9 G4):
 *  - `trial_one_time` S < A: `trial_end = A` + the recurring lines + ONE one-time line = [S, A), charged AT COMPLETION
 *                     (a past S, a future mid-month S and a 1-3 days-from-a-1st S alike). A line under $0.50 is
 *                     forgiven: the session carries no one-time line.
 *  - `trial`          S === A (paid exactly through a 1st at least 72 h out, ruling 8(e)): `trial_end = A` alone, no line.
 * The two invalid Checkout pairings (a one-time line with `proration_behavior`, `trial_end` with
 * `billing_cycle_anchor`) are never built (catchup-session-params.ts asserts it on everything it returns).
 */
export type CheckoutShape = "trial_one_time" | "trial";

/** A: the first 1st at 12:00Z that is >= max(now + 72 h, S). */
export function trialEndFor(i: { start: Date; now: Date }): Date {
  const earliest = Math.max(i.now.getTime() + CATCHUP_TRIAL_MIN_LEAD_MS, i.start.getTime());
  return firstBoundaryNotBefore(new Date(earliest));
}

/** The selector (SA-733r10 nit 4): `trial` iff snap(paid-through) === A, else `trial_one_time`. */
export function catchupShape(i: { paidThrough: Date; now: Date }): CheckoutShape {
  const s = snapToBoundary(i.paidThrough);
  return trialEndFor({ start: s, now: i.now }).getTime() === s.getTime()
    ? "trial"
    : "trial_one_time";
}

export interface CatchupPlan {
  ok: true;
  now: Date;
  /** max(go-live, the billing start): nothing before it is ever billed. */
  floor: Date;
  /** Where the floor comes from: the operator's override, the first activation's period start, or go-live. */
  floorSource: "billing_start_override" | "first_activation" | "go_live";
  /** S: the snapped paid-through (the floor when nothing is paid) - where the one-time line starts. */
  paidThrough: Date;
  paidFromInvoices: boolean;
  /** A (shown as the anchor): the 1st the card starts billing on. */
  anchorAt: Date;
  /** The trial end the session sends: A. */
  trialEndAt: Date;
  shape: CheckoutShape;
  /** The unpaid span the stub covers and what it comes to. */
  stub: {
    from: Date;
    to: Date;
    label: string;
    lines: StubLine[];
    totalCents: number;
    /** 0 < total < $0.50: the line is forgiven (the session carries none). */
    belowStripeMinimum: boolean;
  };
  /**
   * OPEN RfInvoices superseded at settlement: every one whose (snapped) period END is after S - the card subscription
   * bills from S on, so such an invoice would be a second charge (no upper bound: the early-issued next window and a
   * merged short window are voided too).
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
  | "no_billable_price"
  | "billable_addon_not_card_billable"
  | "addon_snapshot_not_catalog"
  | "checkout_addon_without_priced_row"
  | "manual_marker_without_period";

export type CatchupPlanResult = CatchupPlan | { ok: false; reason: CatchupPlanRefusal };

/** The OPEN RfInvoice ids a settlement voids: period end (snapped) after S, with NO upper bound. */
export function supersededOpenInvoiceIds(
  invoices: readonly CatchupInvoice[],
  paidThrough: Date,
): { void: string[]; unplaceable: string[] } {
  const open = invoices.filter((x) => x.status === "OPEN");
  const s = snapToBoundary(paidThrough).getTime();
  return {
    void: open
      .filter((x) => x.periodEnd && snapToBoundary(x.periodEnd).getTime() > s)
      .map((x) => x.id),
    unplaceable: open.filter((x) => !x.periodEnd).map((x) => x.id),
  };
}

export function planCatchup(i: {
  now: Date;
  monthly: number | null;
  addons: readonly CatchupAddon[];
  invoices: readonly CatchupInvoice[];
  /**
   * The tenant's billing start: the operator's override when one exists, else (when omitted and `manual` is given)
   * the first activation's period start. The floor is max(go-live, this).
   */
  billingStart?: Date | null;
  /** The tenant's priced billable add-on ROWS (MF1). Omitted = the check is skipped (pure unit tests only). */
  billableRows?: readonly CatchupAddonRow[];
  /**
   * The tenant's manual activation rows. Present = every non-voided activation window joins the PAID RfInvoice
   * windows in the one paid-coverage walk. Omitted = the pure planner over the PAID RfInvoices alone.
   */
  manual?: { activations: readonly ActivationRecord[] };
}): CatchupPlanResult {
  if (i.monthly == null || Number.isNaN(i.monthly)) {
    return { ok: false, reason: "no_monthly_price" };
  }
  if (!(i.monthly > 0)) return { ok: false, reason: "no_billable_price" };

  let activationWindows: CoverageWindow[] = [];
  let firstActivationStart: Date | null = null;
  if (i.manual) {
    const c = activationClusters(i.manual.activations);
    if (!c.ok) return c;
    activationWindows = c.clusters
      .filter((x) => !x.voided)
      .map((x) => ({ periodStart: x.start, periodEnd: x.end }));
    firstActivationStart = c.firstStart;
  }
  const startTerm = i.billingStart ?? firstActivationStart;
  const floor =
    startTerm && startTerm.getTime() > CATCHUP_GO_LIVE.getTime() ? startTerm : CATCHUP_GO_LIVE;

  const floorSource: CatchupPlan["floorSource"] = i.billingStart
    ? "billing_start_override"
    : floor.getTime() > CATCHUP_GO_LIVE.getTime()
      ? "first_activation"
      : "go_live";

  const paid = i.invoices.filter((x) => x.status === "PAID");
  if (paid.some((x) => !x.periodStart || !x.periodEnd)) {
    return { ok: false, reason: "paid_invoice_without_period" };
  }
  const cov = paidCoverage(floor, {
    paidRfWindows: paid.map((x) => ({ periodStart: x.periodStart!, periodEnd: x.periodEnd! })),
    activationWindows,
  });
  if (!cov.ok) return cov;
  if (i.billableRows) {
    const refusal = addonCardRefusal(i.billableRows, i.addons);
    if (refusal) return { ok: false, reason: refusal };
  }

  const s = snapToBoundary(cov.paidThrough);
  const a = trialEndFor({ start: s, now: i.now });
  const notes: string[] = [];
  const shape: CheckoutShape = a.getTime() === s.getTime() ? "trial" : "trial_one_time";
  const lines = shape === "trial_one_time" ? stubLines(i.monthly, i.addons, s, a) : [];
  const totalCents = lines.reduce((sum, l) => sum + l.cents, 0);
  const belowStripeMinimum = totalCents > 0 && totalCents < STRIPE_MIN_CHARGE_CENTS;
  if (belowStripeMinimum) notes.push("line is under Stripe's $0.50 minimum: it is forgiven");
  if (
    shape === "trial_one_time" &&
    a.getTime() > firstBoundaryNotBefore(new Date(Math.max(i.now.getTime(), s.getTime()))).getTime()
  ) {
    // A moved past the next 1st: that month is paid 1-3 days early (R5-2) - the owner can veto
    notes.push(
      "R5-2: the 1st is under 72 h away, so the line includes the following month (paid 1-3 days early)",
    );
  }

  const superseded = supersededOpenInvoiceIds(i.invoices, s);

  return {
    ok: true,
    now: i.now,
    floor,
    floorSource,
    paidThrough: s,
    paidFromInvoices: cov.reached,
    anchorAt: a,
    trialEndAt: a,
    shape,
    stub: {
      from: s,
      to: a,
      label: describeStub(s, a),
      lines,
      totalCents,
      belowStripeMinimum,
    },
    voidInvoiceIds: superseded.void,
    unplaceableOpenIds: superseded.unplaceable,
    notes,
  };
}
