import { TAX_PERCENT_PRECISION_MESSAGE } from "@routeflow/pricing";
import { taxPercentInputError } from "../lib/tax-percent-input";

/**
 * R5-1 (SA-814 §3, B296): the operator settings screen mirrors web and the API cap: a default tax rate is a
 * percent with at most 4 decimals (the 6-dp line fraction). Pure logic over the typed text.
 */
describe("taxPercentInputError", () => {
  it.each(["", "  ", "8", "8.875", "7.0625", "8.8750", "0", "100"])("accepts %p", (t) => {
    expect(taxPercentInputError(t)).toBeNull();
  });

  it.each(["8.87501", "0.00001", "8.123456"])("refuses %p with the shared message", (t) => {
    expect(taxPercentInputError(t)).toBe(TAX_PERCENT_PRECISION_MESSAGE);
  });

  it("leaves a non-number to the server's own 400 (not a precision problem)", () => {
    expect(taxPercentInputError("abc")).toBeNull();
  });
});
