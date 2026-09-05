// Pin the local timezone so fmtDate's local-timezone rendering and the fake-clock
// tests below are deterministic regardless of the machine running the suite.
process.env.TZ = "UTC";

import {
  fmt,
  fmtShort,
  fmtDate,
  fmtCalendarDate,
  todayIso,
  calendarDaysUntil,
  isInternalEmail,
} from "./formatting";

describe("fmt", () => {
  it("formats a normal value with two decimal places", () => {
    expect(fmt(1234.5)).toBe("$1,234.50");
  });

  it("formats zero", () => {
    expect(fmt(0)).toBe("$0.00");
  });

  it("formats a negative value with a leading minus sign", () => {
    expect(fmt(-50)).toBe("-$50.00");
  });
});

describe("fmtShort", () => {
  it("abbreviates values >= 1000 to one decimal 'k'", () => {
    expect(fmtShort(1234.5)).toBe("$1.2k");
  });

  it("falls back to fmt() for zero", () => {
    expect(fmtShort(0)).toBe("$0.00");
  });

  it("falls back to fmt() for a negative value below the 1000 threshold", () => {
    expect(fmtShort(-50)).toBe("-$50.00");
  });
});

describe("fmtDate", () => {
  it("formats a normal timestamp as 'Mon D, YYYY' in the local timezone", () => {
    expect(fmtDate("2026-06-15T12:00:00.000Z")).toBe("Jun 15, 2026");
  });

  it("returns an em dash for an unparsable string", () => {
    expect(fmtDate("not-a-date")).toBe("—");
  });

  it("returns an em dash for null", () => {
    expect(fmtDate(null)).toBe("—");
  });

  it("returns an em dash for undefined", () => {
    expect(fmtDate(undefined)).toBe("—");
  });
});

describe("fmtCalendarDate", () => {
  it("formats a UTC-midnight calendar date as 'Mon D, YYYY' regardless of local timezone", () => {
    expect(fmtCalendarDate("2026-06-15T00:00:00.000Z")).toBe("Jun 15, 2026");
  });

  it("returns an em dash for an unparsable string", () => {
    expect(fmtCalendarDate("not-a-date")).toBe("—");
  });

  it("returns an em dash for null", () => {
    expect(fmtCalendarDate(null)).toBe("—");
  });

  it("returns an em dash for undefined", () => {
    expect(fmtCalendarDate(undefined)).toBe("—");
  });
});

describe("todayIso and calendarDaysUntil (fake clock pinned to 2026-06-15T12:00:00.000Z)", () => {
  beforeAll(() => {
    jest.useFakeTimers({ now: new Date("2026-06-15T12:00:00.000Z") });
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it("todayIso returns the pinned today in YYYY-MM-DD", () => {
    expect(todayIso()).toBe("2026-06-15");
  });

  describe("calendarDaysUntil", () => {
    it("returns a positive count for a future calendar date", () => {
      expect(calendarDaysUntil("2026-06-20T00:00:00.000Z")).toBe(5);
    });

    it("returns zero for today's calendar date", () => {
      expect(calendarDaysUntil("2026-06-15T00:00:00.000Z")).toBe(0);
    });

    it("returns a negative count for an overdue calendar date", () => {
      expect(calendarDaysUntil("2026-06-10T00:00:00.000Z")).toBe(-5);
    });

    it("returns null for null", () => {
      expect(calendarDaysUntil(null)).toBeNull();
    });

    it("returns null for undefined", () => {
      expect(calendarDaysUntil(undefined)).toBeNull();
    });
  });
});

describe("isInternalEmail", () => {
  it("is true for the no-email placeholder sentinel", () => {
    expect(isInternalEmail("no-email+abc123@placeholder.local")).toBe(true);
  });

  it("is true for the imported-CSV sentinel", () => {
    expect(isInternalEmail("someone@imported.local")).toBe(true);
  });

  it("is false for a normal email", () => {
    expect(isInternalEmail("real@example.com")).toBe(false);
  });

  it("is false for an empty string", () => {
    expect(isInternalEmail("")).toBe(false);
  });

  it("is false for null", () => {
    expect(isInternalEmail(null)).toBe(false);
  });

  it("is false for undefined", () => {
    expect(isInternalEmail(undefined)).toBe(false);
  });
});
