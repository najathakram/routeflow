import { orderOutcomeAfterStop } from "./delivery-plan";

/** SA-1101 U-1: what a stop close makes an order, read from its lines AFTER the recompute. */
describe("orderOutcomeAfterStop (SA-1101 §2.1)", () => {
  it("every line at 0 is REFUSED", () => {
    expect(
      orderOutcomeAfterStop([
        { status: "CONFIRMED", deliveredQty: 0 },
        { status: "CONFIRMED", deliveredQty: "0" },
      ]),
    ).toBe("REFUSED");
  });

  it("one line delivered is DELIVERED (partly refused stays delivered)", () => {
    expect(orderOutcomeAfterStop([{ deliveredQty: 0 }, { deliveredQty: 3 }])).toBe("DELIVERED");
  });

  it("a short line (10 -> 7) is DELIVERED", () => {
    expect(orderOutcomeAfterStop([{ deliveredQty: 7 }])).toBe("DELIVERED");
  });

  it("cancelled lines are dropped: refused plus a cancelled line that carries a quantity is REFUSED", () => {
    expect(
      orderOutcomeAfterStop([{ deliveredQty: 0 }, { status: "CANCELLED", deliveredQty: 5 }]),
    ).toBe("REFUSED");
  });

  it("no lines, or only cancelled lines, is DELIVERED (today's behaviour for an empty order)", () => {
    expect(orderOutcomeAfterStop([])).toBe("DELIVERED");
    expect(orderOutcomeAfterStop([{ status: "CANCELLED", deliveredQty: 0 }])).toBe("DELIVERED");
  });

  it("a quantity at the 0.0005 tolerance counts as nothing delivered", () => {
    expect(orderOutcomeAfterStop([{ deliveredQty: 0.0005 }])).toBe("REFUSED");
    expect(orderOutcomeAfterStop([{ deliveredQty: 0.001 }])).toBe("DELIVERED");
  });

  it("refused this visit but delivered on an earlier one is DELIVERED (recompute sums every visit)", () => {
    expect(orderOutcomeAfterStop([{ deliveredQty: 5 }, { deliveredQty: 0 }])).toBe("DELIVERED");
  });

  it("garbage never picks a status: NaN, Infinity, negative and non-numeric all throw", () => {
    expect(() => orderOutcomeAfterStop([{ deliveredQty: Number.NaN }])).toThrow();
    expect(() => orderOutcomeAfterStop([{ deliveredQty: Infinity }])).toThrow();
    expect(() => orderOutcomeAfterStop([{ deliveredQty: -1 }])).toThrow();
    expect(() => orderOutcomeAfterStop([{ deliveredQty: "abc" }])).toThrow();
  });

  it("a cancelled line's garbage is dropped with the line (rule 1 runs before rule 2)", () => {
    expect(() =>
      orderOutcomeAfterStop([{ deliveredQty: 0 }, { status: "CANCELLED", deliveredQty: -9 }]),
    ).not.toThrow();
  });
});
