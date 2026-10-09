/**
 * SA-744r2 (row 80): manual-pay (RfInvoice) billing windows follow the OWNER'S CALENDAR - the 1st of
 * the month, one month in advance - not the length of the last window. ONE pure module, consumed by
 * the issuer's `windowsFor`, the `rollCycles` external branch, and the builder, so the three can never
 * disagree about a window's shape (L-167).
 *
 * Vocabulary (all UTC, no DST):
 *   - B(m): the 1st of month m at 12:00Z. The same boundary as SA-733r2's Stripe anchor, so it is the 1st in
 *     every US zone and a manual payer's paid-through equals the Stripe anchor (no stub).
 *   - snap: an instant within 24 h of some B(m) - INCLUSIVE, exactly 24 h snaps - is treated as that B(m).
 *     Legacy 00:00Z ends therefore never produce a 12-hour invoice; the up-to-24 h gap or overlap is not billed.
 *   - aligned: a snapped instant that is a B(m).
 *   - alignment window: `[s, next B)` for an unaligned `s`; a window under 3 days is MERGED into the
 *     following month, `[s, B(m+1))` (one invoice, two lines, no tiny invoices).
 */
import type { Cycle } from "../billing-math";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The inclusive snap distance. */
export const SNAP_MS = DAY_MS;
/** B(m) is the 1st at this UTC hour. */
export const BOUNDARY_HOUR_UTC = 12;
/** An alignment window shorter than this is merged into the following month. */
export const MERGE_BELOW_DAYS = 3;
/** A last window at least this long counts as ANNUAL whatever the label says (B863). */
export const ANNUAL_WINDOW_MIN_DAYS = 360;

export interface BillingWindow {
  periodStart: Date;
  periodEnd: Date;
}

/** B(year, monthIndex): the 1st of that month at 12:00Z. `monthIndex` may overflow (Date.UTC carries it). */
export function boundary(year: number, monthIndex: number): Date {
  return new Date(Date.UTC(year, monthIndex, 1, BOUNDARY_HOUR_UTC));
}

/** The B(m) nearest to `d` (the month before, of, and after `d` are the only candidates). */
function nearestBoundary(d: Date): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  let best = boundary(y, m);
  for (const c of [boundary(y, m - 1), boundary(y, m + 1)]) {
    if (Math.abs(c.getTime() - d.getTime()) < Math.abs(best.getTime() - d.getTime())) best = c;
  }
  return best;
}

/** The B(m) `d` snaps to (within 24 h, inclusive), else the same instant (a copy). */
export function snapToBoundary(d: Date): Date {
  const b = nearestBoundary(d);
  return Math.abs(b.getTime() - d.getTime()) <= SNAP_MS ? b : new Date(d.getTime());
}

/** True iff `d` is within the inclusive snap of some B(m). */
export function isAligned(d: Date): boolean {
  return Math.abs(nearestBoundary(d).getTime() - d.getTime()) <= SNAP_MS;
}

/** True iff two instants are the same after snapping (the M1 prior-invoice / contiguity test). */
export function sameSnapped(a: Date, b: Date): boolean {
  return snapToBoundary(a).getTime() === snapToBoundary(b).getTime();
}

/** B(m + n) for an ALIGNED boundary `b` (calendar months, so Feb is 28/29 days and never overflows). */
export function addBoundaryMonths(b: Date, n: number): Date {
  return boundary(b.getUTCFullYear(), b.getUTCMonth() + n);
}

/** The first boundary strictly AFTER `d`. */
export function nextBoundaryAfter(d: Date): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  for (const c of [boundary(y, m), boundary(y, m + 1)]) if (c.getTime() > d.getTime()) return c;
  return boundary(y, m + 2); // unreachable: B(m+1) is always after d
}

/** Whole calendar months between two ALIGNED boundaries (a snapped to b's side, both already snapped). */
export function monthsBetween(a: Date, b: Date): number {
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

/**
 * M4 (B863): a last window of at least 360 days is ANNUAL whatever the label says; otherwise the stored
 * label. The label is never written (other readers keep it). To make such a row monthly, super admin edits
 * the period so its window is under 360 days.
 */
export function effectiveCycle(
  label: Cycle | string,
  periodStart: Date | null,
  periodEnd: Date | null,
): Cycle {
  if (periodStart && periodEnd) {
    const days = (periodEnd.getTime() - periodStart.getTime()) / DAY_MS;
    if (days >= ANNUAL_WINDOW_MIN_DAYS) return "ANNUAL";
  }
  return label === "ANNUAL" ? "ANNUAL" : "MONTHLY";
}

/**
 * THE helper: the window that follows `periodEnd`.
 *   - aligned end (after the snap): MONTHLY `[B(m), B(m+1))`, ANNUAL `[B(m), B(m+12))`;
 *   - unaligned end: MONTHLY alignment window `[end, next B)` (merged to `[end, B+1 month)` when it is under
 *     3 days), ANNUAL `[end, B(next + 12))` - the alignment merged into the first year.
 * `periodStart` is the SNAPPED start for an aligned end, the raw end otherwise.
 */
export function nextBillingWindow(periodEnd: Date, cycle: Cycle): BillingWindow {
  const s = snapToBoundary(periodEnd);
  if (isAligned(periodEnd)) {
    return { periodStart: s, periodEnd: addBoundaryMonths(s, cycle === "ANNUAL" ? 12 : 1) };
  }
  const b1 = nextBoundaryAfter(s);
  if (cycle === "ANNUAL") return { periodStart: s, periodEnd: addBoundaryMonths(b1, 12) };
  const gapDays = (b1.getTime() - s.getTime()) / DAY_MS;
  return {
    periodStart: s,
    periodEnd: gapDays < MERGE_BELOW_DAYS ? addBoundaryMonths(b1, 1) : b1,
  };
}

/** A part of an invoice window: whole calendar months at the full price, or a prorated alignment stretch. */
export type WindowPart =
  { kind: "FULL"; months: number } | { kind: "ALIGN"; daysRemaining: number; daysInCycle: number };

/**
 * M3 (exact alignment proration). For an alignment stretch `[s, B(m))` the cycle that contains it is
 * `[B(m-1), B(m))`: `daysInCycle` is its exact length (Nov 30, Feb 2028 29) and `daysRemaining` the EXACT
 * fractional days to B(m) - never rounded up (`billing-math.daysBetween` is not used).
 */
export function alignPart(start: Date, boundaryEnd: Date): WindowPart {
  const prev = addBoundaryMonths(boundaryEnd, -1);
  return {
    kind: "ALIGN",
    daysRemaining: (boundaryEnd.getTime() - start.getTime()) / DAY_MS,
    daysInCycle: (boundaryEnd.getTime() - prev.getTime()) / DAY_MS,
  };
}

/**
 * Parses an invoice window into parts, or null when it is a shape the helper never produces (the builder
 * then falls back to the length-based months and flags it IRREGULAR_PERIOD - a defensive notice, not
 * normal flow).
 *   - aligned start and end: `n` calendar months (ANNUAL: exactly 12);
 *   - unaligned start, aligned end: ALIGN to the next boundary, then 0 or 1 full month (ANNUAL: 0 or 12).
 */
export function windowParts(start: Date, end: Date, cycle: Cycle): WindowPart[] | null {
  if (!(end.getTime() > start.getTime())) return null;
  if (!isAligned(end)) return null;
  const e = snapToBoundary(end);
  const annual = cycle === "ANNUAL";
  if (isAligned(start)) {
    const n = monthsBetween(snapToBoundary(start), e);
    if (annual) return n === 12 ? [{ kind: "FULL", months: 1 }] : null;
    return n >= 1 ? [{ kind: "FULL", months: n }] : null;
  }
  const b1 = nextBoundaryAfter(start);
  if (e.getTime() < b1.getTime()) return null;
  const parts: WindowPart[] = [alignPart(start, b1)];
  const rest = monthsBetween(b1, e);
  if (rest === 0) return parts;
  if (annual ? rest === 12 : rest === 1) {
    parts.push({ kind: "FULL", months: 1 });
    return parts;
  }
  return null;
}

/** An invoice window crossing the calendar "regularly": the shape check behind the census and the notice. */
export function isCalendarWindow(start: Date, end: Date, cycle: Cycle): boolean {
  return windowParts(start, end, cycle) !== null;
}

/**
 * SA-733r4 r4a (lead ruling, from SA-744r2 item 4), verbatim: "contiguous = next periodStart within the
 * inclusive 24 h snap of the previous periodEnd; paid-through = snap(last periodEnd)."
 */
export function isContiguous(previousEnd: Date, nextStart: Date): boolean {
  return sameSnapped(previousEnd, nextStart);
}

/**
 * Paid-through of a set of PAID periods, walked forward from `from` (default: the earliest start). Each
 * period that starts at or before the running end - or contiguous with it under the snap - and ends later
 * extends the run; a gap stops it. Returns snap(run end), or null when `from` is omitted and there are no
 * periods. A period that does not reach `from` (an older, already-consumed one) is ignored.
 */
export function paidThrough(periods: readonly BillingWindow[], from?: Date): Date | null {
  if (periods.length === 0 && !from) return null;
  const sorted = [...periods].sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime());
  let runEnd = from ?? sorted[0].periodStart;
  for (const p of sorted) {
    const reaches =
      p.periodStart.getTime() <= runEnd.getTime() || isContiguous(runEnd, p.periodStart);
    if (reaches && p.periodEnd.getTime() > runEnd.getTime()) runEnd = p.periodEnd;
  }
  return snapToBoundary(runEnd);
}
