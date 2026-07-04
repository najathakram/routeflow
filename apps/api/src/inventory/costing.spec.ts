import { Prisma } from "@prisma/client";
import { costDecimal, nextAverageCost, planLotConsumption, reverseAverageCost } from "./costing";

const D = (n: number | string) => new Prisma.Decimal(n);

describe("costDecimal", () => {
  it("clamps to 4 decimal places, half-up", () => {
    expect(costDecimal("1.00005").toString()).toBe("1.0001");
    expect(costDecimal("1.00004").toString()).toBe("1");
    expect(costDecimal(2.5).toString()).toBe("2.5");
  });

  it("accepts number, string and Decimal inputs", () => {
    expect(costDecimal(3).toString()).toBe("3");
    expect(costDecimal("3.12345").toString()).toBe("3.1235");
    expect(costDecimal(D("0.33333333")).toString()).toBe("0.3333");
  });
});

describe("nextAverageCost", () => {
  it("resets to the incoming unit cost when current stock is zero", () => {
    expect(nextAverageCost(D(0), D(9.99), D(10), D(2)).toString()).toBe("2");
  });

  it("resets to the incoming unit cost when current stock is negative", () => {
    expect(nextAverageCost(D(-4), D(9.99), D(10), D(2)).toString()).toBe("2");
  });

  it("computes the weighted average of existing stock and the new purchase", () => {
    // 10 @ 2.00 + 5 @ 3.50 = (20 + 17.5) / 15 = 2.50
    expect(nextAverageCost(D(10), D(2), D(5), D(3.5)).toString()).toBe("2.5");
  });

  it("treats a null current average as zero", () => {
    // 10 @ (null=0) + 5 @ 3.00 = 15 / 15 = 1.00
    expect(nextAverageCost(D(10), null, D(5), D(3)).toString()).toBe("1");
  });

  it("clamps non-terminating divisions to 4dp", () => {
    // 1 @ 1.00 + 2 @ 2.00 = 5 / 3 = 1.66666… → 1.6667
    expect(nextAverageCost(D(1), D(1), D(2), D(2)).toString()).toBe("1.6667");
  });
});

describe("reverseAverageCost", () => {
  it("is the exact inverse of nextAverageCost", () => {
    const next = nextAverageCost(D(10), D(2), D(5), D(3.5)); // 2.5
    expect(reverseAverageCost(D(15), next, D(5), D(3.5))!.toString()).toBe("2");
  });

  it("returns null (keep previous average) when the reversal empties stock", () => {
    expect(reverseAverageCost(D(5), D(2.5), D(5), D(3))).toBeNull();
  });

  it("returns null when the reversal overshoots stock", () => {
    expect(reverseAverageCost(D(5), D(2.5), D(8), D(3))).toBeNull();
  });

  it("returns null instead of producing a negative average", () => {
    // 10 @ 0.50 removing 5 @ 2.00 → numerator 5 - 10 = -5
    expect(reverseAverageCost(D(10), D(0.5), D(5), D(2))).toBeNull();
  });

  it("clamps the reversed average to 4dp", () => {
    // stock 4 avg 1.25, remove 1 @ 1.00 → (5 - 1) / 3 = 1.3333…
    expect(reverseAverageCost(D(4), D(1.25), D(1), D(1))!.toString()).toBe("1.3333");
  });
});

describe("planLotConsumption", () => {
  const lot = (id: string, remainingQty: number, unitCost: number) => ({
    id,
    remainingQty: D(remainingQty),
    unitCost: D(unitCost),
  });

  it("consumes lots in the given order and blends their costs", () => {
    // 5 @ 1.00 then 3 (of 10) @ 2.00 → (5 + 6) / 8 = 1.375
    const plan = planLotConsumption([lot("a", 5, 1), lot("b", 10, 2)], D(8), D(9));
    expect(plan.consumptions).toEqual([
      { id: "a", take: D(5) },
      { id: "b", take: D(3) },
    ]);
    expect(plan.weightedUnitCost.toString()).toBe("1.375");
    expect(plan.uncovered.toString()).toBe("0");
  });

  it("prices the uncovered remainder at the fallback cost", () => {
    // 5 @ 1.00 covered, 3 uncovered @ 2.00 fallback → (5 + 6) / 8 = 1.375
    const plan = planLotConsumption([lot("a", 5, 1)], D(8), D(2));
    expect(plan.consumptions).toEqual([{ id: "a", take: D(5) }]);
    expect(plan.weightedUnitCost.toString()).toBe("1.375");
    expect(plan.uncovered.toString()).toBe("3");
  });

  it("falls back entirely when no lots are available", () => {
    const plan = planLotConsumption([], D(4), D(2.5));
    expect(plan.consumptions).toEqual([]);
    expect(plan.weightedUnitCost.toString()).toBe("2.5");
    expect(plan.uncovered.toString()).toBe("4");
  });

  it("skips lots with nothing remaining", () => {
    const plan = planLotConsumption([lot("empty", 0, 1), lot("b", 10, 2)], D(4), D(9));
    expect(plan.consumptions).toEqual([{ id: "b", take: D(4) }]);
    expect(plan.weightedUnitCost.toString()).toBe("2");
  });

  it("returns the fallback cost for a zero quantity", () => {
    const plan = planLotConsumption([lot("a", 5, 1)], D(0), D(2.5));
    expect(plan.consumptions).toEqual([]);
    expect(plan.weightedUnitCost.toString()).toBe("2.5");
    expect(plan.uncovered.toString()).toBe("0");
  });

  it("clamps the blended cost to 4dp", () => {
    // 1 @ 1.00 + 2 @ 2.00 over qty 3 → 5/3 = 1.6667
    const plan = planLotConsumption([lot("a", 1, 1), lot("b", 2, 2)], D(3), D(9));
    expect(plan.weightedUnitCost.toString()).toBe("1.6667");
  });
});
