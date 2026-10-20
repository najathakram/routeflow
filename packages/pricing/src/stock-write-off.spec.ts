import { isWriteOff, writeOffValue } from "./stock-write-off";

describe("SA-804(3) isWriteOff / writeOffValue", () => {
  const adj = (quantity: number, reason: string | null, avgCostAfter: number | null = 2.5) => ({
    type: "ADJUSTMENT",
    quantity,
    reason,
    avgCostAfter,
  });

  it("a negative ADJUSTMENT with a loss reason is a write-off", () => {
    for (const r of ["DAMAGED", "EXPIRED", "THEFT", "SAMPLE"])
      expect(isWriteOff(adj(-3, r))).toBe(true);
  });

  it("a count correction, OTHER, no reason, a positive delta or another type is not", () => {
    expect(isWriteOff(adj(-3, "COUNT_CORRECTION"))).toBe(false);
    expect(isWriteOff(adj(-3, "OTHER"))).toBe(false);
    expect(isWriteOff(adj(-3, null))).toBe(false);
    expect(isWriteOff(adj(3, "DAMAGED"))).toBe(false);
    expect(isWriteOff({ type: "SALE", quantity: -3, reason: "DAMAGED" })).toBe(false);
  });

  it("values it at |qty| × the movement's avgCostAfter, rounded to the cent", () => {
    expect(writeOffValue(adj(-3, "DAMAGED", 1.2345))).toBe(3.7);
    expect(
      writeOffValue({ ...adj(-2, "EXPIRED"), quantity: "-2.000", avgCostAfter: "0.3333" }),
    ).toBe(0.67);
    expect(writeOffValue(adj(-3, "COUNT_CORRECTION"))).toBe(0);
    expect(writeOffValue(adj(-3, "THEFT", null))).toBe(0);
  });
});
