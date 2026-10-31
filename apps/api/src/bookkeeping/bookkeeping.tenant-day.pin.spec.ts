/**
 * SA-906 / W-728: Bookkeeping windows on the TENANT's own day. Structural pin: the service builds no period from the host clock
 * or a hand-rolled `setUTCHours(23, 59, 59, 999)`; every window comes from `tenantPeriod` / `calendarDayRange`. A new report that
 * re-derives its own window fails here. The regulated period bucket (UTC by contract) lives elsewhere and is not scanned.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { eventWindowOf } from "../common/invoiced-sales";
import { periodBucketOf } from "../regulated/period";

const src = readFileSync(join(__dirname, "bookkeeping.service.ts"), "utf8")
  .split("\n")
  .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
  .join("\n");

describe("bookkeeping.service windows (SA-906)", () => {
  it.each([
    [
      "host-clock year/month starts",
      /new Date\(now\.getFullYear\(\)|new Date\(new Date\(\)\.getFullYear\(\)/,
    ],
    ["host-clock month arithmetic", /now\.getMonth\(\)/],
    ["hand-rolled end of day", /setUTCHours\(23, 59, 59, 999\)/],
    ["host-clock setDate windows", /\.setDate\(/],
  ])("has no %s", (_n, re) => {
    expect(src).not.toMatch(re);
  });

  // SA-1057 F-2: a real-instant `createdAt` is filtered on `period.instants`. Two calendar-stamp reads remain on purpose
  // (estimates, a raw payment listing); the count only goes down.
  it("keeps at most 2 `createdAt: { gte: fromDate` calendar-stamp reads", () => {
    expect(src.split("createdAt: { gte: fromDate").length - 1).toBeLessThanOrEqual(2);
  });

  it("routes every window through tenantPeriod / calendarDayRange", () => {
    expect(src).toMatch(/tenantPeriod\(/);
    expect(src).toMatch(/calendarDayRange\(/);
  });
});

describe("eventWindowOf: real-instant columns use the tenant's own days", () => {
  const CHICAGO = "America/Chicago";
  const win = { gte: new Date("2026-10-01T00:00:00Z"), lte: new Date("2026-10-31T23:59:59.999Z") };

  it("R1/R2: a credit at 23:30 local on Oct 31 is in October; 22:00 local on Sep 30 is out (Chicago)", () => {
    const w = eventWindowOf(win, CHICAGO) as { gte: Date; lt: Date };
    const inOct = new Date("2026-11-01T04:30:00Z");
    const inSep = new Date("2026-10-01T03:00:00Z");
    expect(inOct >= w.gte && inOct < w.lt).toBe(true);
    expect(inSep >= w.gte && inSep < w.lt).toBe(false);
  });

  it("R9: a null zone returns the window as given (UTC, today's behaviour)", () => {
    expect(eventWindowOf(win, null)).toBe(win);
  });

  it("R3: Sydney is ahead of UTC: the window opens at local midnight, before the UTC day starts", () => {
    const w = eventWindowOf(win, "Australia/Sydney") as { gte: Date };
    expect(w.gte.getTime()).toBeLessThan(win.gte.getTime());
  });
});

/**
 * SA-1057 F-6: MUST 1's full ban list and call-site rule, as pure functions over a source string, with a self-test so the pin
 * cannot rot into passing everything. The service has nine accrual reads; every one passes the tenant's zone.
 */
const BANNED: Array<[string, RegExp]> = [
  ["new Date(y, m, d)", /new Date\(\s*[^()]*,[^()]*\)/],
  ["getFullYear", /\.getFullYear\(/],
  ["getMonth", /\.getMonth\(/],
  ["setDate", /\.setDate\(/],
  ["setHours", /\.setHours\(/],
  ["hand-built end of day", /T23:59:59\.999Z/],
];
const bannedIn = (source: string) => BANNED.filter(([, re]) => re.test(source)).map(([n]) => n);

/** The text of each `name(...)` call, balanced across lines; a longer name (`nameByCustomer(`) is not a match. */
function callsOf(source: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?<![A-Za-z0-9_])${name}\\(`, "g");
  for (let m = re.exec(source); m; m = re.exec(source)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
    }
    out.push(source.slice(m.index, i));
  }
  return out;
}
const ACCRUAL_READS = [
  "fetchAccrualNetSales",
  "fetchAccrualNetSalesByCustomer",
  "fetchBadDebtExpense",
];
// A call is zone-less when it names no `timeZone` at all, or names one only as a literal `null` / `undefined` (UTC by another route).
const zonelessCalls = (source: string) =>
  ACCRUAL_READS.flatMap((n) => callsOf(source, n)).filter(
    (c) => !/timeZone/.test(c) || /timeZone\s*:\s*(null|undefined)\b/.test(c),
  );

describe("SA-1057 F-6: MUST 1's ban list and the zone at every accrual read", () => {
  it("bans every host-clock window construct MUST 1 names", () => {
    expect(bannedIn(src)).toEqual([]);
  });

  it("every fetchAccrualNetSales / ByCustomer / fetchBadDebtExpense call passes the zone, and there are nine", () => {
    const calls = ACCRUAL_READS.flatMap((n) => callsOf(src, n));
    expect(calls).toHaveLength(9);
    expect(zonelessCalls(src)).toEqual([]);
  });

  it("self-test: each banned sample and a zone-less call go red; a zoned multi-line call passes", () => {
    for (const [sample, rule] of [
      ["const d = new Date(y, m, 1);", "new Date(y, m, d)"],
      ["now.getFullYear()", "getFullYear"],
      ["now.getMonth()", "getMonth"],
      ["d.setDate(1)", "setDate"],
      ["d.setHours(0)", "setHours"],
      ["new Date(`${to}T23:59:59.999Z`)", "hand-built end of day"],
    ] as const) {
      expect(bannedIn(sample)).toContain(rule);
    }
    expect(bannedIn("new Date(period.days.lt.getTime() - 1)")).toEqual([]);
    expect(zonelessCalls("await fetchAccrualNetSales(db, tenantId, window);")).toHaveLength(1);
    expect(
      zonelessCalls(
        "fetchBadDebtExpense(\n  db,\n  tenantId,\n  { gte },\n  { timeZone: zone },\n)",
      ),
    ).toEqual([]);
    expect(
      zonelessCalls("fetchAccrualNetSales(db, tenantId, w, { timeZone: null });"),
    ).toHaveLength(1);
    expect(
      zonelessCalls("fetchBadDebtExpense(db, tenantId, w, { timeZone:undefined })"),
    ).toHaveLength(1);
    expect(callsOf("fetchAccrualNetSalesByCustomer(a)", "fetchAccrualNetSales")).toEqual([]);
  });
});

describe("SA-1057 F-7: the regulated period bucket stays UTC and is not reached by the tenant-day helper (R12)", () => {
  it("calendar-date.ts imports nothing from regulated/", () => {
    const calendar = readFileSync(join(__dirname, "..", "common", "calendar-date.ts"), "utf8");
    expect(calendar).not.toMatch(/from\s+["'][^"']*regulated\//);
  });

  it("R12: a Chicago-edge instant (23:30 CDT on Oct 31) is still the UTC month 2026-11 for the filing bucket", () => {
    expect(periodBucketOf(new Date("2026-11-01T04:30:00Z"))).toBe("2026-11");
  });
});
