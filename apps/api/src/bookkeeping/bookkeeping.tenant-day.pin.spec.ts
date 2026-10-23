/**
 * SA-906 / W-728: Bookkeeping windows on the TENANT's own day. Structural pin: the service builds no period from the host clock
 * or a hand-rolled `setUTCHours(23, 59, 59, 999)`; every window comes from `tenantPeriod` / `calendarDayRange`. A new report that
 * re-derives its own window fails here. The regulated period bucket (UTC by contract) lives elsewhere and is not scanned.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { eventWindowOf } from "../common/invoiced-sales";

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
