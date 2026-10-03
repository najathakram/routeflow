import { creditLimitForSubmit, isCreditLimitInput } from "../lib/customer-credit-limit";

/** B1018 / SA-642 (mirrors web): a blanked box on an EDIT of a customer that had a limit clears it (null); a create omits it. */
describe("creditLimitForSubmit", () => {
  it("edit: blanked box on a customer that had a limit -> null", () => {
    expect(creditLimitForSubmit("", "edit", true)).toBeNull();
    expect(creditLimitForSubmit("  ", "edit", true)).toBeNull();
  });
  it("edit: blank box, no stored limit -> nothing sent", () => {
    expect(creditLimitForSubmit("", "edit", false)).toBeUndefined();
  });
  it("create: blank -> omitted, never null", () => {
    expect(creditLimitForSubmit("", "create", false)).toBeUndefined();
    expect(creditLimitForSubmit("", "create", true)).toBeUndefined();
  });
  it("a typed number is sent; 0 is a real $0 limit", () => {
    expect(creditLimitForSubmit("500", "edit", true)).toBe(500);
    expect(creditLimitForSubmit("250.50", "create", false)).toBe(250.5);
    expect(creditLimitForSubmit("0", "edit", true)).toBe(0);
  });
  it("garbage or negative never clears and never sends", () => {
    for (const bad of ["abc", "-5", "12.345", "1e3"])
      expect(creditLimitForSubmit(bad, "edit", true)).toBeUndefined();
  });
});

describe("isCreditLimitInput", () => {
  it("accepts blank and up to two decimals only", () => {
    for (const ok of ["", "0", "500", "250.5", "250.50"]) expect(isCreditLimitInput(ok)).toBe(true);
    for (const bad of ["abc", "-1", "1.234", "1,000"]) expect(isCreditLimitInput(bad)).toBe(false);
  });
});
