import { parseNaturalDate, dayLabel, relativeDaysLabel } from "./natural-date";

// W-1188 N1: the counter's typed date. Monday 2026-11-09 is "today" unless a case says otherwise.
const MON = "2026-11-09";
const p = (s: string, today = MON, o?: Parameters<typeof parseNaturalDate>[2]) =>
  parseNaturalDate(s, today, o);

describe("parseNaturalDate", () => {
  it("reads today and yesterday words", () => {
    expect(p("today")).toBe(MON);
    expect(p("tdy")).toBe(MON);
    expect(p("yesterday")).toBe("2026-11-08");
    expect(p("yday")).toBe("2026-11-08");
    expect(p("y")).toBe("2026-11-08");
  });

  it("reads tomorrow only where the future is allowed", () => {
    expect(p("tomorrow")).toBe("2026-11-10");
    expect(p("tmrw")).toBe("2026-11-10");
    expect(p("tomorrow", MON, { allowFuture: false })).toBeNull();
  });

  it("a weekday is the most recent one on or before today; next <weekday> is the coming one", () => {
    expect(p("fri")).toBe("2026-11-06");
    expect(p("friday")).toBe("2026-11-06");
    expect(p("mon")).toBe(MON); // today is a Monday: on or before today
    expect(p("next fri")).toBe("2026-11-13");
    expect(p("next mon")).toBe("2026-11-16");
  });

  it("a month and day with no year is the occurrence nearest today (a tie goes to the past)", () => {
    expect(p("11/02")).toBe("2026-11-02");
    expect(p("11-2")).toBe("2026-11-02");
    expect(p("nov 2")).toBe("2026-11-02");
    expect(p("2 nov")).toBe("2026-11-02");
    expect(p("12/30", "2027-01-03")).toBe("2026-12-30");
    expect(p("01/02", "2026-12-30")).toBe("2027-01-02");
  });

  it("reads a typed year", () => {
    expect(p("11/02/25")).toBe("2025-11-02");
    expect(p("11/02/2025")).toBe("2025-11-02");
    expect(p("2025-11-02")).toBe("2025-11-02");
  });

  it("reads offsets", () => {
    expect(p("-3")).toBe("2026-11-06");
    expect(p("3d ago")).toBe("2026-11-06");
    expect(p("+2")).toBe("2026-11-11");
  });

  it("refuses what is not a day", () => {
    expect(p("garbage")).toBeNull();
    expect(p("")).toBeNull();
    expect(p("02/31")).toBeNull();
    expect(p("13/01")).toBeNull();
  });

  it("the day order is an argument, month first by default", () => {
    expect(p("11/05")).toBe("2026-11-05");
    expect(p("11/05", MON, { dayOrder: "DMY" })).toBe("2026-05-11");
  });
});

describe("labels", () => {
  it("dayLabel adds the year only when it is not the tenant's year", () => {
    expect(dayLabel("2026-11-06", MON)).toBe("Fri, Nov 6");
    expect(dayLabel("2025-12-30", MON)).toBe("Tue, Dec 30, 2025");
  });
  it("relativeDaysLabel", () => {
    expect(relativeDaysLabel("2026-11-06", MON)).toBe("3 days ago");
    expect(relativeDaysLabel("2026-11-08", MON)).toBe("yesterday");
    expect(relativeDaysLabel("2026-11-16", MON)).toBe("in 7 days");
    expect(relativeDaysLabel("2026-11-10", MON)).toBe("tomorrow");
  });
});
