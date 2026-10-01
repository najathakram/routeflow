/**
 * B954: PDF date formatting must be anchored to UTC. Calendar dates (issue/due/statement days) are
 * stored as UTC-midnight instants; formatted with the host's LOCAL zone they render a day early on
 * any host west of UTC. Railway runs UTC so prod hides it; this pins the behaviour on a western
 * host by setting TZ before any Date is formatted. The templates are `.tsx` and stubbed under Jest
 * (apps/api/package.json moduleNameMapper), so the rule lives in this pure helper shared by the
 * bookkeeping-invoice and buyer-statement PDF templates.
 */
process.env.TZ = "America/Los_Angeles";

import { fmtPdfDate } from "./pdf-date";

describe("fmtPdfDate is UTC-anchored (B954)", () => {
  it("the test host really is west of UTC (guards a vacuous pass)", () => {
    expect(new Date("2026-01-15T00:00:00.000Z").getDate()).toBe(14);
  });

  it("a UTC-midnight calendar date renders as THAT day, not the day before", () => {
    expect(fmtPdfDate(new Date("2026-01-15T00:00:00.000Z"))).toBe("Jan 15, 2026");
    expect(fmtPdfDate("2026-03-01T00:00:00.000Z")).toBe("Mar 1, 2026");
  });

  it("the last millisecond of a UTC day stays on that day; the first of the next moves on", () => {
    expect(fmtPdfDate(new Date("2026-01-31T23:59:59.999Z"))).toBe("Jan 31, 2026");
    expect(fmtPdfDate(new Date("2026-02-01T00:00:00.000Z"))).toBe("Feb 1, 2026");
  });

  it("null, undefined and an empty string render an em dash", () => {
    expect(fmtPdfDate(null)).toBe("—");
    expect(fmtPdfDate(undefined)).toBe("—");
    expect(fmtPdfDate("")).toBe("—");
  });
});
