/**
 * Issue 5: quantity inputs must step in whole units — no decimals, no leading
 * zeros. Locks the sanitizer applied to every order/invoice qty/box/piece field.
 */
import { sanitizeIntInput, parseIntQty, commitQtyDraft } from "../lib/qty";

describe("sanitizeIntInput", () => {
  it("strips a leading zero as you type", () => {
    expect(sanitizeIntInput("05")).toBe("5");
    expect(sanitizeIntInput("007")).toBe("7");
  });

  it("keeps a single zero", () => {
    expect(sanitizeIntInput("0")).toBe("0");
    expect(sanitizeIntInput("00")).toBe("0");
  });

  it("drops decimals (and anything after the separator)", () => {
    expect(sanitizeIntInput("1.5")).toBe("1");
    expect(sanitizeIntInput("2,9")).toBe("2");
    expect(sanitizeIntInput("0.5")).toBe("0"); // integer part of 0.5 is 0
  });

  it("removes stray non-digits", () => {
    expect(sanitizeIntInput("12a")).toBe("12");
    expect(sanitizeIntInput("-3")).toBe("3");
  });

  it("returns empty for blank/nullish input (allows mid-edit clearing)", () => {
    expect(sanitizeIntInput("")).toBe("");
    expect(sanitizeIntInput(null)).toBe("");
    expect(sanitizeIntInput(undefined)).toBe("");
  });
});

describe("parseIntQty", () => {
  it("parses to an integer", () => {
    expect(parseIntQty("05")).toBe(5);
    expect(parseIntQty("12")).toBe(12);
    expect(parseIntQty("1.9")).toBe(1);
  });

  it("falls back when blank", () => {
    expect(parseIntQty("")).toBe(0);
    expect(parseIntQty("", 1)).toBe(1);
  });
});

describe("commitQtyDraft", () => {
  it("empty draft commits 0 by default (emptyMeansZero)", () => {
    expect(commitQtyDraft("")).toBe(0);
    expect(commitQtyDraft(null)).toBe(0);
    expect(commitQtyDraft(undefined)).toBe(0);
  });

  it("empty draft reverts (null) when emptyMeansZero is false", () => {
    expect(commitQtyDraft("", { emptyMeansZero: false })).toBeNull();
  });

  it("below-min typed value reverts (null)", () => {
    expect(commitQtyDraft("0", { min: 1 })).toBeNull();
  });

  it('"0" with default min commits 0', () => {
    expect(commitQtyDraft("0")).toBe(0);
  });

  it("clamps above max (no rollover)", () => {
    expect(commitQtyDraft("15", { max: 11 })).toBe(11);
  });

  it("strips leading zeros", () => {
    expect(commitQtyDraft("007")).toBe(7);
  });

  it("garbage input is treated as empty per emptyMeansZero", () => {
    expect(commitQtyDraft("abc")).toBe(0);
    expect(commitQtyDraft("abc", { emptyMeansZero: false })).toBeNull();
  });

  it("truncates fractional input to its integer part", () => {
    expect(commitQtyDraft("1.5")).toBe(1);
  });

  it("respects a non-default min for a valid value", () => {
    expect(commitQtyDraft("3", { min: 1 })).toBe(3);
  });
});
