import { lineBackorderPieces } from "@routeflow/types/order-line-backorder";
import { orderLineCardModel } from "../lib/order-line-display";

/** SA-714 R1: the staff-only "Backorder" tag on the operator order-detail card (pure logic). */
function line(over: Record<string, unknown> = {}) {
  return {
    id: "li-1",
    productId: "p-1",
    product: { name: "Sample Cola 12oz", unit: "each", sku: "100200300" },
    qty: 8,
    unitPrice: 65,
    priceType: "STANDARD",
    status: "PENDING",
    subtotal: 520,
    deliveredQty: 0,
    ...over,
  } as Parameters<typeof orderLineCardModel>[0];
}

describe("Backorder tag (mobile card model)", () => {
  it("carries the pieces for a live order and says so to a screen reader", () => {
    const m = orderLineCardModel(line({ backorderedPieces: "3" }), "PENDING");
    expect(m.backorderPieces).toBe(3);
    expect(m.spoken).toContain("backorder");
  });
  it("none at 0, on a legacy row, on a cancelled line, or on a cancelled/delivered/draft order", () => {
    expect(orderLineCardModel(line({ backorderedPieces: "0" }), "PENDING").backorderPieces).toBe(0);
    expect(orderLineCardModel(line(), "PENDING").backorderPieces).toBe(0);
    expect(
      orderLineCardModel(line({ backorderedPieces: "3", status: "CANCELLED" }), "PENDING")
        .backorderPieces,
    ).toBe(0);
    for (const s of ["CANCELLED", "DELIVERED", "DRAFT"]) {
      expect(orderLineCardModel(line({ backorderedPieces: "3" }), s).backorderPieces).toBe(0);
    }
  });
  it("the shared rule", () => {
    expect(lineBackorderPieces({ backorderedPieces: 2.5 }, "OUT_FOR_DELIVERY")).toBe(2.5);
    expect(lineBackorderPieces({ backorderedPieces: "x" }, "PENDING")).toBe(0);
  });
});
