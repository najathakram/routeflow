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

describe("row 280: annual = monthly x 10 is whole cents, never float noise", () => {
  // 33.33 * 10 is 333.29999999999995 and 19.99 * 10 is 199.89999999999998 in binary floating point.
  it.each([
    [33.33, 333.3],
    [19.99, 199.9],
    [0.07, 0.7],
  ])("a catalog monthly of %s has an annual of exactly %s", (monthly, annual) => {
    const r = resolvePlanPrice({ monthlyPrice: monthly }, null);
    expect(r).toMatchObject({ ok: true, source: "catalog", monthly, annual });
  });

  it.each([
    [33.33, 333.3],
    [19.99, 199.9],
  ])(
    "a custom monthly fee of %s with no annual fee has an annual of exactly %s",
    (monthly, annual) => {
      const r = resolvePlanPrice({ monthlyPrice: 99 }, { monthly });
      expect(r).toMatchObject({ ok: true, source: "override", monthly, annual });
    },
  );

  it("an explicit annual price is used as given, and a deliberate 0 stays 0", () => {
    expect(resolvePlanPrice({ monthlyPrice: 33.33, annualPrice: 300 }, null)).toMatchObject({
      annual: 300,
    });
    expect(resolvePlanPrice({ monthlyPrice: 33.33, annualPrice: 0 }, null)).toMatchObject({
      annual: 0,
    });
    expect(resolvePlanPrice({ monthlyPrice: 99 }, { monthly: 33.33, annual: 0 })).toMatchObject({
      annual: 0,
    });
  });
});
