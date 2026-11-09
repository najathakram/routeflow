import { tierWarns, tiersBreakOrder } from "./tier-order";

// W-1170 F2: a tier stored as 0 is Auto (follows Retail); the order check skips it with the prices grid on.
describe("tiersBreakOrder", () => {
  it("skipAuto: an Auto tier 2 never makes tier 3 a violation, and an Auto tier never warns", () => {
    expect(tiersBreakOrder(1.25, [0, 1.1, 0, 0], 1, true)).toBe(false);
    expect(tiersBreakOrder(1.25, [0, 1.1, 0, 0], 0, true)).toBe(false);
    expect(tiersBreakOrder(1.25, [0, 1.1, 0, 0], 2, true)).toBe(false);
  });

  it("skipAuto: compares against the nearest priced tier above, else Retail", () => {
    expect(tiersBreakOrder(1.25, [0, 2, 0, 0], 1, true)).toBe(true); // above Retail
    expect(tiersBreakOrder(1.25, [1, 0, 1.2, 0], 2, true)).toBe(true); // above tier 2 (skipping Auto tier 3)
    expect(tiersBreakOrder(1.25, [1, 0, 0.9, 0], 2, true)).toBe(false);
  });

  it("without skipAuto a 0 compares as a price, as before", () => {
    expect(tiersBreakOrder(1.25, [0, 1.1, 0, 0], 1, false)).toBe(true);
    expect(tiersBreakOrder(1.25, [1, 0.9, 0.8, 0.7], 1, false)).toBe(false);
  });
});

describe("tierWarns", () => {
  const product = { priceTier2: "0", priceTier3: "1.1", priceTier4: "0", priceTier5: null };
  it("reads the draft first, then the saved product, and a missing tier follows Retail", () => {
    expect(tierWarns(1, {}, product, 1.25, true)).toBe(false);
    expect(tierWarns(1, { priceTier3: "2" }, product, 1.25, true)).toBe(true);
    expect(tierWarns(1, { pricePerUnit: "1" }, product, 1.25, true)).toBe(true);
  });
});
