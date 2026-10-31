/**
 * SA-906 / W-728: tenantPeriod, the ONE period every report windows on. Zones are DATA (L-047): America/Chicago (west),
 * Australia/Sydney (east), a DST edge, and a null zone. No host-clock oracle (CI runs TZ=UTC, which hides the bug).
 */
import { calendarDayRange, tenantPeriod } from "./calendar-date";

const CHICAGO = "America/Chicago";
const SYDNEY = "Australia/Sydney";
const iso = (d: Date) => d.toISOString();

describe("tenantPeriod kinds are relative to the TENANT's today", () => {
  it("R5: 'this month' at 2026-11-01T02:00Z is OCTOBER in Chicago (it is 21:00 CDT on Oct 31)", () => {
    const p = tenantPeriod("month", CHICAGO, new Date("2026-11-01T02:00:00Z"));
    expect([p.fromDay, p.toDay]).toEqual(["2026-10-01", "2026-10-31"]);
  });

  it("R6: 'year' at 2027-01-01T03:00Z is the 2026 year to date in Chicago (Dec 31 21:00 CST)", () => {
    const p = tenantPeriod("year", CHICAGO, new Date("2027-01-01T03:00:00Z"));
    expect([p.fromDay, p.toDay]).toEqual(["2026-01-01", "2026-12-31"]);
  });

  it("R7: Sydney at 2026-10-31T15:00Z is already Nov 1 (02:00 AEDT): today and this month include Nov 1's stamp", () => {
    const now = new Date("2026-10-31T15:00:00Z");
    const today = tenantPeriod("today", SYDNEY, now);
    expect([today.fromDay, today.toDay]).toEqual(["2026-11-01", "2026-11-01"]);
    // an invoice issued today carries the stamp 2026-11-01T00:00Z: inside [gte, lt), though it is after `now` in UTC
    expect(iso(today.days.gte)).toBe("2026-11-01T00:00:00.000Z");
    expect(iso(today.days.lt)).toBe("2026-11-02T00:00:00.000Z");
    const month = tenantPeriod("month", SYDNEY, now);
    expect([month.fromDay, month.toDay]).toEqual(["2026-11-01", "2026-11-01"]);
  });

  it("week starts on Sunday of the tenant's week; quarter on the quarter's first day", () => {
    // 2026-10-22 (Thursday) in Chicago
    const now = new Date("2026-10-22T15:00:00Z");
    const w = tenantPeriod("week", CHICAGO, now);
    expect([w.fromDay, w.toDay]).toEqual(["2026-10-18", "2026-10-22"]);
    const q = tenantPeriod("quarter", CHICAGO, now);
    expect([q.fromDay, q.toDay]).toEqual(["2026-10-01", "2026-10-22"]);
    const q2 = tenantPeriod("quarter", CHICAGO, new Date("2026-08-05T12:00:00Z"));
    expect(q2.fromDay).toBe("2026-07-01");
  });

  it("{ month } is a whole month of the tenant's current year (0-based), including December", () => {
    const now = new Date("2026-11-15T12:00:00Z");
    const feb = tenantPeriod({ month: 1 }, CHICAGO, now);
    expect([feb.fromDay, feb.toDay]).toEqual(["2026-02-01", "2026-02-28"]);
    const dec = tenantPeriod({ month: 11 }, CHICAGO, now);
    expect([dec.fromDay, dec.toDay]).toEqual(["2026-12-01", "2026-12-31"]);
    // R5a: a credit at 2027-01-01T05:30Z (Dec 31 23:30 CST) is inside December's INSTANT window, not a stray January
    expect(iso(dec.instants.gte)).toBe("2026-12-01T06:00:00.000Z");
    expect(iso(dec.instants.lt)).toBe("2027-01-01T06:00:00.000Z");
    const credit = new Date("2027-01-01T05:30:00Z");
    expect(credit >= dec.instants.gte && credit < dec.instants.lt).toBe(true);
  });
});

describe("tenantPeriod explicit and default ranges", () => {
  it("explicit days are taken as named; the default is the tenant's year to date", () => {
    const now = new Date("2026-10-22T15:00:00Z");
    expect(
      tenantPeriod({ fromDay: "2026-09-01", toDay: "2026-09-30" }, CHICAGO, now),
    ).toMatchObject({ fromDay: "2026-09-01", toDay: "2026-09-30" });
    const d = tenantPeriod({}, CHICAGO, now);
    expect([d.fromDay, d.toDay]).toEqual(["2026-01-01", "2026-10-22"]);
    // a full ISO datetime names its first ten characters (the client date), a bad value falls back
    expect(
      tenantPeriod({ fromDay: "2026-09-01T12:00:00Z", toDay: "garbage" }, CHICAGO, now),
    ).toMatchObject({
      fromDay: "2026-09-01",
      toDay: "2026-10-22",
    });
  });

  it("R2/R1 edges: an October-only period puts a credit at 2026-11-01T04:30Z in October and 2026-10-01T03:00Z outside it (Chicago)", () => {
    const oct = tenantPeriod({ fromDay: "2026-10-01", toDay: "2026-10-31" }, CHICAGO);
    const lateOct31 = new Date("2026-11-01T04:30:00Z"); // 23:30 CDT Oct 31
    const earlySep30 = new Date("2026-10-01T03:00:00Z"); // 22:00 CDT Sep 30
    expect(lateOct31 >= oct.instants.gte && lateOct31 < oct.instants.lt).toBe(true);
    expect(earlySep30 >= oct.instants.gte && earlySep30 < oct.instants.lt).toBe(false);
  });

  it("R10 DST: the window ending Nov 1 2026 (the 25-hour day in Chicago) includes 01:30 CST and 01:30 CDT", () => {
    const p = tenantPeriod({ fromDay: "2026-11-01", toDay: "2026-11-01" }, CHICAGO);
    expect(iso(p.instants.gte)).toBe("2026-11-01T05:00:00.000Z"); // midnight CDT
    expect(iso(p.instants.lt)).toBe("2026-11-02T06:00:00.000Z"); // midnight CST (25 hours later)
    for (const t of ["2026-11-01T06:30:00Z", "2026-11-01T07:30:00Z"]) {
      const at = new Date(t);
      expect(at >= p.instants.gte && at < p.instants.lt).toBe(true);
    }
  });

  it("R8 guard: calendar-date columns never shift: the day stamps are the same in every zone", () => {
    const args = { fromDay: "2026-10-01", toDay: "2026-10-31" };
    const a = tenantPeriod(args, CHICAGO);
    const b = tenantPeriod(args, SYDNEY);
    const c = tenantPeriod(args, null);
    for (const p of [a, b, c]) {
      expect(iso(p.days.gte)).toBe("2026-10-01T00:00:00.000Z");
      expect(iso(p.days.lt)).toBe("2026-11-01T00:00:00.000Z");
    }
  });

  it("R9 guard: a null or unknown zone is UTC (today's behaviour)", () => {
    const now = new Date("2026-10-31T23:30:00Z");
    for (const zone of [null, undefined, "Not/AZone"]) {
      const p = tenantPeriod("month", zone, now);
      expect([p.fromDay, p.toDay]).toEqual(["2026-10-01", "2026-10-31"]);
      expect(iso(p.instants.gte)).toBe("2026-10-01T00:00:00.000Z");
      expect(iso(p.instants.lt)).toBe("2026-11-01T00:00:00.000Z");
    }
  });
});

describe("calendarDayRange (optional list filters on a calendar column)", () => {
  it("a missing side is open; the whole last day is in (lt = the next day's stamp)", () => {
    expect(calendarDayRange()).toEqual({});
    const r = calendarDayRange("2026-10-01", "2026-10-31");
    expect(iso(r.gte as Date)).toBe("2026-10-01T00:00:00.000Z");
    expect(iso(r.lt as Date)).toBe("2026-11-01T00:00:00.000Z");
    expect(calendarDayRange("2026-10-01").lt).toBeUndefined();
    expect(calendarDayRange(undefined, "2026-10-31").gte).toBeUndefined();
    expect(calendarDayRange("junk", "")).toEqual({});
  });
});
