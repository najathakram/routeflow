import { cascadeTierPrices, getTierPrice } from "./pricing";

/**
 * Locks the tier ladder semantics — this 17-line function is the whole tier
 * pricing engine, and it had ZERO coverage while the web/mobile mirrors
 * diverged (missing `|| fallback` → $0.00 for DB-default-0 tier columns).
 * The web and mobile mirrors must match this behavior byte-for-byte; the
 * mobile mirror is locked by apps/mobile/__tests__/pricing.test.ts.
 */
describe("getTierPrice", () => {
  const product = {
    pricePerUnit: "10.00",
    priceTier2: "9.00",
    priceTier3: "8.50",
    priceTier4: "0", // DB default — tier never configured
    priceTier5: null as string | null, // legacy row — column null
  };

  it("returns the configured tier price", () => {
    expect(getTierPrice(product, 2)).toBe(9);
    expect(getTierPrice(product, 3)).toBe(8.5);
  });

  it("tier 1 is the list price", () => {
    expect(getTierPrice(product, 1)).toBe(10);
  });

  it("an unset tier (DB default 0) inherits the list price — the $0.00 regression", () => {
    expect(getTierPrice(product, 4)).toBe(10);
  });

  it("a null tier column inherits the list price", () => {
    expect(getTierPrice(product, 5)).toBe(10);
  });

  it("out-of-range tiers fall back to list", () => {
    expect(getTierPrice(product, 0)).toBe(10);
    expect(getTierPrice(product, 6)).toBe(10);
    expect(getTierPrice(product, NaN)).toBe(10);
  });

  it("coerces numeric and string decimals alike", () => {
    expect(getTierPrice({ pricePerUnit: 12.5, priceTier2: 11.25 }, 2)).toBe(11.25);
    expect(getTierPrice({ pricePerUnit: "12.50", priceTier2: "11.25" }, 2)).toBe(11.25);
  });

  it("a genuinely free product stays 0 (no fallback available)", () => {
    expect(getTierPrice({ pricePerUnit: "0", priceTier2: "0" }, 2)).toBe(0);
  });

  it("unparseable tier values fall back to list price", () => {
    expect(getTierPrice({ pricePerUnit: "10.00", priceTier2: "abc" }, 2)).toBe(10);
  });
});

describe("cascadeTierPrices", () => {
  it("copies the committed price down to every lower tier", () => {
    expect(cascadeTierPrices("priceTier2", 9)).toEqual({
      priceTier3: "9.00",
      priceTier4: "9.00",
      priceTier5: "9.00",
    });
  });

  it("cascades only to the tiers below the edited one", () => {
    expect(cascadeTierPrices("priceTier4", 8.5)).toEqual({ priceTier5: "8.50" });
  });

  it("tier 5 has nothing below it", () => {
    expect(cascadeTierPrices("priceTier5", 7)).toEqual({});
  });

  it("Tier 1 / pricePerUnit is deliberately excluded from the cascade", () => {
    expect(cascadeTierPrices("pricePerUnit", 10)).toEqual({});
  });

  it("rejects non-finite or negative input", () => {
    expect(cascadeTierPrices("priceTier2", NaN)).toEqual({});
    expect(cascadeTierPrices("priceTier2", -1)).toEqual({});
  });

  it("rounds half-up at the cent", () => {
    expect(cascadeTierPrices("priceTier2", 9.005)).toEqual({
      priceTier3: "9.01",
      priceTier4: "9.01",
      priceTier5: "9.01",
    });
  });

  it("committing 0 cascades an explicit 0.00 — the tiers inherit list price again under getTierPrice's fallback", () => {
    expect(cascadeTierPrices("priceTier3", 0)).toEqual({
      priceTier4: "0.00",
      priceTier5: "0.00",
    });
  });
});
