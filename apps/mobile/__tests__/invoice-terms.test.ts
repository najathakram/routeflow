/**
 * Wave 2: the extracted payment-term constants + due-date math
 * (lib/invoice-terms.ts) — previously duplicated in invoices/new.tsx and
 * SplitInvoiceScreen.tsx with no coverage.
 */
import {
  DEFAULT_TERMS,
  ISO_DATE,
  TERM_CHIPS,
  commitCustomDays,
  customDaysBlocksCreate,
  customTermsFromInput,
  daysForTerms,
  TERM_OPTIONS,
  dueDateFor,
  todayPlusDays,
} from "../lib/invoice-terms";

describe("term constants", () => {
  it("options and chips derive from the shared presets in order", () => {
    expect(TERM_OPTIONS).toEqual([
      "Due on Receipt",
      "Net 7",
      "Net 15",
      "Net 30",
      "Net 45",
      "Net 60",
      "Net 90",
    ]);
    expect(TERM_CHIPS).toEqual(TERM_OPTIONS.map((label) => ({ label })));
    expect(daysForTerms(DEFAULT_TERMS)).toBe(30);
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

describe("W-1487: Net 7, Net 90 and a custom Net N (B-3, B-4)", () => {
  it("B-3: 2026-03-01 + Net 7 is 2026-03-08 and + Net 30 is 2026-03-31", () => {
    expect(dueDateFor("2026-03-01", "Net 7")).toBe("2026-03-08");
    expect(dueDateFor("2026-03-01", "Net 30")).toBe("2026-03-31");
  });

  it("B-4: 2026-11-26 + Net 90 is 2027-02-24", () => {
    expect(dueDateFor("2026-11-26", "Net 90")).toBe("2027-02-24");
  });

  it("a custom Net 21 runs 21 days; the options offer the shared presets", () => {
    expect(dueDateFor("2026-03-01", "Net 21")).toBe("2026-03-22");
    expect(TERM_OPTIONS).toEqual([
      "Due on Receipt",
      "Net 7",
      "Net 15",
      "Net 30",
      "Net 45",
      "Net 60",
      "Net 90",
    ]);
  });
});

describe("W-1487: the custom days box (B-7, mobile)", () => {
  it("a typed 21 is Net 21; 0, 366, 7.5 and words are refused inline", () => {
    expect(customTermsFromInput("21")).toEqual({ label: "Net 21", error: null });
    for (const bad of ["0", "366", "7.5", "-3", "abc"]) {
      expect(customTermsFromInput(bad).label).toBeNull();
      expect(customTermsFromInput(bad).error).toMatch(/1 to 365/);
    }
    expect(customTermsFromInput("")).toEqual({ label: null, error: null });
  });
});

describe("W-1487: commitCustomDays (the custom box commits only a valid number)", () => {
  it("a valid number commits its label and clears the error", () => {
    expect(commitCustomDays("21", "Net 30")).toEqual({ terms: "Net 21", error: null });
  });

  it("0, 366, 7.5 and words keep the old terms and show the error", () => {
    for (const bad of ["0", "366", "7.5", "abc"]) {
      expect(commitCustomDays(bad, "Net 30")).toEqual({
        terms: "Net 30",
        error: "Enter a whole number of days from 1 to 365.",
      });
    }
  });

  it("an emptied box (deleting the last digit) keeps the terms and shows no error", () => {
    expect(commitCustomDays("", "Net 30")).toEqual({ terms: "Net 30", error: null });
  });
});

describe("W-1487: customDaysBlocksCreate (a bad custom box blocks create)", () => {
  it("a valid number, an empty box and an untouched box do not block", () => {
    expect(customDaysBlocksCreate("21")).toBe(false);
    expect(customDaysBlocksCreate("")).toBe(false);
    expect(customDaysBlocksCreate(undefined)).toBe(false);
  });

  it("0, 366, 7.5 and words block create, so Net 36 is never sent for a typed 366", () => {
    for (const bad of ["0", "366", "7.5", "abc"]) expect(customDaysBlocksCreate(bad)).toBe(true);
  });
});
