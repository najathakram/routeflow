import { formatDate } from "./messaging.helpers";

// ─── formatDate — timezone regression (invoice dates/terms bugfix, WP2) ─────
//
// Invoice.issueDate/dueDate are stored as UTC-midnight instants. Formatting
// them via local-time `toLocaleDateString` (no `timeZone` option) renders UTC
// midnight of day D as D-1 for any negative-UTC-offset process/reader — this
// is the executable proof that formatDate no longer does that, independent of
// whatever timezone the test runner happens to be in.

describe("formatDate — UTC-safe calendar dates", () => {
  it("formats a UTC-midnight instant as the SAME calendar day in any timezone", () => {
    // 2026-08-04T00:00:00.000Z must render as Aug 4 REGARDLESS of process TZ.
    const formatted = formatDate(new Date("2026-08-04T00:00:00.000Z"));
    expect(formatted).toBe("August 4, 2026");
    expect(formatted).not.toContain("August 3");
  });

  it("holds when passed the raw ISO string directly (no pre-wrapped Date)", () => {
    const formatted = formatDate("2026-08-04T00:00:00.000Z");
    expect(formatted).toBe("August 4, 2026");
    expect(formatted).not.toContain("August 3");
  });

  it("holds at a month boundary (UTC midnight Mar 1 must not render as Feb 28/29)", () => {
    const formatted = formatDate(new Date("2026-03-01T00:00:00.000Z"));
    expect(formatted).toBe("March 1, 2026");
    expect(formatted).not.toContain("February");
  });
});
