import {
  costPerSellingUnit,
  computeMarginFraction,
  priceForMarginFloor,
  classifyMargin,
} from "../lib/pricing";

describe("margin helpers (mirrors apps/api/src/common/pricing.spec.ts)", () => {
  it("costPerSellingUnit scales piece cost to the box for boxed products", () => {
    expect(costPerSellingUnit(0.58, 24)).toBeCloseTo(13.92, 5);
    expect(costPerSellingUnit(0.58, 1)).toBe(0.58);
    expect(costPerSellingUnit(0.58, null)).toBe(0.58);
  });

  it("computeMarginFraction uses box-basis cost vs box price", () => {
    const m = computeMarginFraction(21.6, 0.58, 24);
    expect(m! * 100).toBeCloseTo(35.56, 1);
  });

  it("computeMarginFraction is negative below cost and null without cost/price", () => {
    expect(computeMarginFraction(10, 8, 1)! * 100).toBeCloseTo(20, 5);
    expect(computeMarginFraction(5, 8, 1)).toBeLessThan(0);
    expect(computeMarginFraction(10, null, 1)).toBeNull();
    expect(computeMarginFraction(0, 8, 1)).toBeNull();
  });

  it("priceForMarginFloor yields exactly the floor margin (round-trip)", () => {
    const price = priceForMarginFloor(0.58, 0.2, 24);
    const m = computeMarginFraction(price, 0.58, 24)!;
    expect(m).toBeCloseTo(0.2, 2);
    expect(priceForMarginFloor(8, 0.25, 1)).toBe(10.67);
  });

  it("classifyMargin buckets below-cost / below-floor / warn / ok", () => {
    const floor = 0.15;
    expect(classifyMargin(-0.05, floor)).toBe("belowCost");
    expect(classifyMargin(0.1, floor)).toBe("belowFloor");
    expect(classifyMargin(0.17, floor)).toBe("warn");
    expect(classifyMargin(0.3, floor)).toBe("ok");
    expect(classifyMargin(null, floor)).toBeNull();
  });
});
