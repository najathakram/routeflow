import { creditLimitForSubmit, isCreditLimitInput } from "./customer-credit-limit";

/**
 * B1018 / SA-642: a blank credit-limit box on an EDIT clears the limit (null) only when the box was deliberately blanked, i.e.
 * the customer HAD a limit and it is now empty. A create omits the field; garbage never clears; 0 is a real limit.
 */
describe("creditLimitForSubmit", () => {
  it("update: a blanked box on a customer that had a limit sends null (clear)", () => {
    expect(creditLimitForSubmit("", "update", true)).toBeNull();
    expect(creditLimitForSubmit("   ", "update", true)).toBeNull();
    expect(creditLimitForSubmit(undefined, "update", true)).toBeNull();
  });

  it("update: a blank box on a customer that never had a limit sends nothing (no accidental write)", () => {
    expect(creditLimitForSubmit("", "update", false)).toBeUndefined();
  });

  it("create: a blank box omits the field, never null", () => {
    expect(creditLimitForSubmit("", "create", false)).toBeUndefined();
    expect(creditLimitForSubmit("", "create", true)).toBeUndefined();
  });

  it("a typed number is sent as a number, and 0 is a real $0 limit (not blank)", () => {
    expect(creditLimitForSubmit("500", "update", true)).toBe(500);
    expect(creditLimitForSubmit("250.50", "create", false)).toBe(250.5);
    expect(creditLimitForSubmit("0", "update", true)).toBe(0);
    expect(creditLimitForSubmit("0", "create", false)).toBe(0);
  });

  it("garbage or a negative value never clears and never sends: it is undefined (the form refuses it first)", () => {
    for (const bad of ["abc", "-5", "1e3x", "NaN", "12.345"])
      expect(creditLimitForSubmit(bad, "update", true)).toBeUndefined();
  });
});

describe("isCreditLimitInput", () => {
  it("accepts blank, whole and two-decimal non-negative amounts; refuses the rest", () => {
    for (const ok of ["", "0", "500", "250.5", "250.50", " 12 "])
      expect(isCreditLimitInput(ok)).toBe(true);
    for (const bad of ["abc", "-1", "1.234", "1,000", "1e3"])
      expect(isCreditLimitInput(bad)).toBe(false);
  });
});
