import { BATCH_SHIP_COPY, buildBatchShipRows, shippedOrderIds } from "../lib/batch-ship-copy";

const OUTCOMES = [
  "SHIPPED",
  "SHIPPED_INVOICE_PENDING",
  "NOT_CARRIER_ORDER",
  "ALREADY_SHIPPED",
  "NOT_CONFIRMED",
  "CREDIT_HOLD",
  "ORDER_CHANGED",
  "INVALID_TRACKING",
  "NOT_FOUND",
  "FAILED",
] as const;

describe("batch ship outcome copy", () => {
  it("has non-empty copy for every outcome (same ten as packages/types)", () => {
    expect(Object.keys(BATCH_SHIP_COPY).sort()).toEqual([...OUTCOMES].sort());
    for (const o of OUTCOMES) {
      expect(BATCH_SHIP_COPY[o].label.length).toBeGreaterThan(0);
      expect(BATCH_SHIP_COPY[o].detail.length).toBeGreaterThan(0);
    }
  });
  it("only the two SHIPPED outcomes feed packing slips", () => {
    expect(
      shippedOrderIds(OUTCOMES.map((outcome) => ({ orderId: outcome, outcome }))).sort(),
    ).toEqual(["SHIPPED", "SHIPPED_INVOICE_PENDING"]);
  });
  it("refusals never read as shipped", () => {
    expect(BATCH_SHIP_COPY.CREDIT_HOLD.tone).toBe("error");
    expect(BATCH_SHIP_COPY.ALREADY_SHIPPED.shipped).toBe(false);
  });
});

describe("buildBatchShipRows", () => {
  it("sends carrier + tracking only when tracking was typed", () => {
    expect(
      buildBatchShipRows(["a", "b", "c"], { a: "fedex" }, { a: " 1Z ", b: "  " }, "ups"),
    ).toEqual([
      { orderId: "a", carrier: "fedex", trackingNumber: "1Z" },
      { orderId: "b" },
      { orderId: "c" },
    ]);
  });
  it("defaults the carrier", () => {
    expect(buildBatchShipRows(["a"], {}, { a: "T" }, "ups")).toEqual([
      { orderId: "a", carrier: "ups", trackingNumber: "T" },
    ]);
  });
});
