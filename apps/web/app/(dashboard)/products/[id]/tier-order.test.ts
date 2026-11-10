import { tierWarns, tiersBreakOrder } from "./tier-order";

// W-1170 F2: a tier stored as 0 is Auto and charges Retail (getTierPrice), so with the prices grid on the order check
// compares what each tier charges: effective = tier > 0 ? tier : Retail.
describe("tiersBreakOrder", () => {
  it("skipAuto: an Auto tier below a lower priced tier charges Retail, so it warns (Retail 1.25, T2 1.00, T3 Auto)", () => {
    expect(tiersBreakOrder(1.25, [1.0, 0, 0, 0], 1, true)).toBe(true);
    expect(tiersBreakOrder(1.25, [1.0, 0, 0, 0], 0, true)).toBe(false);
  });

  it("skipAuto: a priced tier is checked against the tier above's effective price (T4 1.05 after an Auto T3)", () => {
    // T3 Auto charges 1.25: T4 1.05 is below it (no warning on T4), T3 itself is above T2 1.00 (warning on T3)
    expect(tiersBreakOrder(1.25, [1.0, 0, 1.05, 0], 2, true)).toBe(false);
    expect(tiersBreakOrder(1.25, [1.0, 0, 1.05, 0], 1, true)).toBe(true);
    // T4 above the effective 1.25 of the Auto T3 is a violation
    expect(tiersBreakOrder(1.25, [1.3, 0, 1.3, 0], 2, true)).toBe(true);
  });

  it("skipAuto: an Auto tier under Retail with Auto tiers above it follows Retail and never warns", () => {
    expect(tiersBreakOrder(1.25, [0, 0, 0, 0], 0, true)).toBe(false);
    expect(tiersBreakOrder(1.25, [0, 0, 0, 0], 3, true)).toBe(false);
    expect(tiersBreakOrder(1.25, [0, 1.1, 1.05, 1], 1, true)).toBe(false);
  });

  it("skipAuto: tier 2 is checked against Retail, and a tier above Retail warns", () => {
    expect(tiersBreakOrder(1.25, [2, 0, 0, 0], 0, true)).toBe(true);
    expect(tiersBreakOrder(1.25, [1.25, 1.25, 1.2, 0], 2, true)).toBe(false);
  });

  it("without skipAuto a 0 compares as a price, as before", () => {
    expect(tiersBreakOrder(1.25, [0, 1.1, 0, 0], 1, false)).toBe(true);
    expect(tiersBreakOrder(1.25, [1, 0.9, 0.8, 0.7], 1, false)).toBe(false);
  });
});

describe("tierWarns", () => {
  const product = { priceTier2: "0", priceTier3: "1.1", priceTier4: "1.05", priceTier5: null };
  it("reads the draft first, then the saved product, and a missing tier follows Retail", () => {
    expect(tierWarns(1, {}, product, 1.25, true)).toBe(false);
    expect(tierWarns(1, { priceTier3: "2" }, product, 1.25, true)).toBe(true);
    expect(tierWarns(1, { pricePerUnit: "1" }, product, 1.25, true)).toBe(true);
    // Retail 1.25, T2 1.00, T3 Auto: T3 charges Retail, above T2
    expect(tierWarns(1, { priceTier2: "1", priceTier3: "0" }, product, 1.25, true)).toBe(true);
    // tier 5 is missing (follows Retail 1.25), above tier 4 1.05
    expect(tierWarns(3, {}, product, 1.25, true)).toBe(true);
  });
});

// W-1170 round 2: Auto is Retail less the tenant's tier rule (from @routeflow/pricing), not always Retail.
describe("tiersBreakOrder with tier rules", () => {
  const rules = { 2: 10 };
  it("Retail 20, Tier 2 Auto under a 10% rule charges 18, so a typed Tier 3 of 19 breaks the order", () => {
    expect(tiersBreakOrder(20, [0, 19, 0, 0], 1, true, rules)).toBe(true);
  });
  it("with no rule the same row is fine (Tier 2 Auto charges Retail 20)", () => {
    expect(tiersBreakOrder(20, [0, 19, 0, 0], 1, true)).toBe(false);
  });
  it("tierWarns carries the rules through", () => {
    const product = { priceTier2: "0", priceTier3: "19", priceTier4: "0", priceTier5: "0" };
    expect(tierWarns(1, {}, product, 20, true, rules)).toBe(true);
    expect(tierWarns(1, {}, product, 20, true)).toBe(false);
  });
});
