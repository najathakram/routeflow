/**
 * Wave 2: the extracted payment-term constants + due-date math
 * (lib/invoice-terms.ts) — previously duplicated in invoices/new.tsx and
 * SplitInvoiceScreen.tsx with no coverage.
 */
import {
  DEFAULT_TERMS,
  ISO_DATE,
  TERM_CHIPS,
  TERM_DAYS,
  TERM_OPTIONS,
  dueDateFor,
  todayPlusDays,
} from "../lib/invoice-terms";

describe("term constants", () => {
  it("options and chips derive from TERM_DAYS in order", () => {
    expect(TERM_OPTIONS).toEqual(["Due on Receipt", "Net 15", "Net 30", "Net 45", "Net 60"]);
    expect(TERM_CHIPS).toEqual(TERM_OPTIONS.map((label) => ({ label })));
    expect(TERM_DAYS[DEFAULT_TERMS]).toBe(30);
  });
});

describe("dueDateFor", () => {
  it("adds the term's day count to an explicit issue date (UTC, no DST drift)", () => {
    expect(dueDateFor("2026-01-31", "Net 15")).toBe("2026-02-15");
    expect(dueDateFor("2026-08-01", "Net 30")).toBe("2026-08-31");
    expect(dueDateFor("2026-08-01", "Due on Receipt")).toBe("2026-08-01");
  });

  it("crosses a year boundary correctly", () => {
    expect(dueDateFor("2026-12-20", "Net 45")).toBe("2027-02-03");
  });

  it("unknown term falls back to 30 days (web's behaviour)", () => {
    expect(dueDateFor("2026-08-01", "whatever")).toBe("2026-08-31");
  });

  it("blank/invalid issue date falls back to today + term days", () => {
    expect(dueDateFor("", "Net 15")).toBe(todayPlusDays(15));
    expect(dueDateFor("not-a-date", "Due on Receipt")).toBe(todayPlusDays(0));
  });

  it("always returns an ISO date", () => {
    for (const term of TERM_OPTIONS) {
      expect(dueDateFor("2026-06-15", term)).toMatch(ISO_DATE);
      expect(dueDateFor("", term)).toMatch(ISO_DATE);
    }
  });
});
