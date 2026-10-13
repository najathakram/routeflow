// SA-744r2 (row 80) - the calendar-window math for READ-ONLY owner reports, which cannot import the API's
// TypeScript. It is apps/api/src/billing/rf-invoice/calendar-windows.ts, verbatim in behaviour; the parity
// spec (apps/api/src/billing/rf-invoice/calendar-windows-script.parity.spec.ts) pins the two over random
// inputs, so a change on either side is a red build. Never re-derive this inline in a script.
//
// Pure: no connection, no logging, no exit.

const DAY_MS = 24 * 60 * 60 * 1000;
const SNAP_MS = DAY_MS;
const MERGE_BELOW_DAYS = 3;
const ANNUAL_WINDOW_MIN_DAYS = 360;

const boundary = (year, monthIndex) => new Date(Date.UTC(year, monthIndex, 1, 12));

function nearestBoundary(d) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  let best = boundary(y, m);
  for (const c of [boundary(y, m - 1), boundary(y, m + 1)]) {
    if (Math.abs(c.getTime() - d.getTime()) < Math.abs(best.getTime() - d.getTime())) best = c;
  }
  return best;
}

const isAligned = (d) => Math.abs(nearestBoundary(d).getTime() - d.getTime()) <= SNAP_MS;
const snapToBoundary = (d) => (isAligned(d) ? nearestBoundary(d) : new Date(d.getTime()));
const addBoundaryMonths = (b, n) => boundary(b.getUTCFullYear(), b.getUTCMonth() + n);

function nextBoundaryAfter(d) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  for (const c of [boundary(y, m), boundary(y, m + 1)]) if (c.getTime() > d.getTime()) return c;
  return boundary(y, m + 2);
}

function effectiveCycle(label, periodStart, periodEnd) {
  if (periodStart && periodEnd) {
    if ((periodEnd.getTime() - periodStart.getTime()) / DAY_MS >= ANNUAL_WINDOW_MIN_DAYS) {
      return "ANNUAL";
    }
  }
  return label === "ANNUAL" ? "ANNUAL" : "MONTHLY";
}

function nextBillingWindow(periodEnd, cycle) {
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

/** The exact alignment fraction of `[start, boundaryEnd)` against the cycle that contains it. */
function alignFraction(start, boundaryEnd) {
  const prev = addBoundaryMonths(boundaryEnd, -1);
  return {
    daysRemaining: (boundaryEnd.getTime() - start.getTime()) / DAY_MS,
    daysInCycle: (boundaryEnd.getTime() - prev.getTime()) / DAY_MS,
  };
}

module.exports = {
  DAY_MS,
  boundary,
  isAligned,
  snapToBoundary,
  nextBoundaryAfter,
  nextBillingWindow,
  effectiveCycle,
  alignFraction,
};
