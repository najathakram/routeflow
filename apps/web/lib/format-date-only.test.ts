// PIN-B79 T30 — must run under a non-UTC host timezone to prove the formatter is
// UTC-fixed and never shifts a stored calendar-date value onto the previous local day.
// Node >= 13 honours a runtime TZ change; CI is Node 20. Set BEFORE any import.
process.env.TZ = "America/New_York";

import { formatDateOnly } from "./format-date-only";

describe("formatDateOnly", () => {
  it("renders a UTC-midnight ISO instant as its own UTC calendar day, not the previous local day", () => {
    expect(formatDateOnly("2026-09-01T00:00:00.000Z")).toBe("Sep 1, 2026");
  });

  it("renders a bare calendar-date string the same way as the equivalent UTC-midnight instant", () => {
    expect(formatDateOnly("2026-09-01")).toBe("Sep 1, 2026");
  });

  it("returns an empty string for null", () => {
    expect(formatDateOnly(null)).toBe("");
  });

  it("returns an empty string for undefined", () => {
    expect(formatDateOnly(undefined)).toBe("");
  });

  it("returns an empty string for an invalid date", () => {
    expect(formatDateOnly("not-a-date")).toBe("");
  });
});
