import {
  ADVANCE_METHOD,
  CASH_METHOD_FILTER,
  CONFIRMED_PAYMENT,
  CONFIRMED_STATUS,
  CREDIT_NOTE_METHOD,
  resolveConfirmedAmounts,
  splitConfirmed,
  sumConfirmed,
} from "./payment-predicates";
import * as Pricing from "@routeflow/pricing";

/**
 * Thin facade test: the core REG-B421 cases (split math, the all-or-nothing
 * resolveConfirmedAmounts guard, the DRAFT/VOID/method matrix) now live in
 * `packages/pricing/src/payment-confirmation.spec.ts` — this file only proves
 * `./payment-predicates` re-exports the SAME functions/constants from
 * `@routeflow/pricing`, not a diverged copy.
 */
describe("payment-predicates re-exports @routeflow/pricing verbatim", () => {
  it("every export is identity-equal to the pricing package's own export", () => {
    expect(sumConfirmed).toBe(Pricing.sumConfirmed);
    expect(splitConfirmed).toBe(Pricing.splitConfirmed);
    expect(resolveConfirmedAmounts).toBe(Pricing.resolveConfirmedAmounts);
    expect(CONFIRMED_STATUS).toBe(Pricing.CONFIRMED_STATUS);
    expect(CONFIRMED_PAYMENT).toEqual(Pricing.CONFIRMED_PAYMENT);
    expect(CREDIT_NOTE_METHOD).toBe(Pricing.CREDIT_NOTE_METHOD);
    expect(ADVANCE_METHOD).toBe(Pricing.ADVANCE_METHOD);
    expect(CASH_METHOD_FILTER).toEqual(Pricing.CASH_METHOD_FILTER);
  });

  it("REG-B421 smoke case still resolves correctly through the facade", () => {
    const payments = [
      { amount: 232, status: "PAID", method: "CASH" },
      { amount: 638, status: "PAID", method: CREDIT_NOTE_METHOD },
      { amount: 100, status: "PAID", method: ADVANCE_METHOD },
    ];
    expect(splitConfirmed(payments)).toEqual({
      cash: 232,
      creditApplied: 638,
      advanceApplied: 100,
    });
  });
});
