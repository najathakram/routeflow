/**
 * SA-733 D8: the ONE price rule checkout (`PlatformPricingService`) and the plan-change Stripe push share —
 * a per-tenant custom fee beats the catalog price, annual defaults to monthly x 10.
 */
import { resolvePlanPrice } from "./plan-price";

describe("resolvePlanPrice — the one price rule checkout and the plan-change push share", () => {
  const def = { monthlyPrice: 249, annualPrice: 2000 };
  it("a custom fee beats the catalog; annual defaults to monthly x 10", () => {
    expect(resolvePlanPrice(def, { monthly: 300 })).toEqual({
      ok: true,
      monthly: 300,
      annual: 3000,
      source: "override",
    });
  });
  it("no override -> catalog; an annualPrice of 0 is a real price, not 'unset'", () => {
    expect(resolvePlanPrice({ monthlyPrice: 249, annualPrice: 0 }, null)).toMatchObject({
      monthly: 249,
      annual: 0,
      source: "catalog",
    });
    expect(resolvePlanPrice({ monthlyPrice: 249 }, null)).toMatchObject({ annual: 2490 });
  });
  it("is unresolvable for a custom plan with no fee, and for an annual-only fee on a custom plan", () => {
    expect(resolvePlanPrice({ monthlyPrice: null }, null)).toEqual({
      ok: false,
      reason: "no_catalog_price",
    });
    expect(resolvePlanPrice({ monthlyPrice: null }, { annual: 5000 })).toEqual({
      ok: false,
      reason: "annual_override_without_monthly",
    });
  });
});
