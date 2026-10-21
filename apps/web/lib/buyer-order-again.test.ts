import { orderAgainCartLines } from "./buyer-order-again";

// Row 604 review M2: order-cancel marks every line CANCELLED, so a cancelled ORDER must still reorder.
const line = (over: Record<string, unknown> = {}) => ({
  status: "CONFIRMED",
  productId: "p1",
  qty: 6,
  product: { name: "Widget", unit: "each", unitsPerBox: null },
  ...over,
});

describe("orderAgainCartLines", () => {
  it("skips a cancelled line on a live order", () => {
    expect(
      orderAgainCartLines([line({ status: "CANCELLED" }), line({ productId: "p2" })]),
    ).toHaveLength(1);
  });

  it("a CANCELLED order adds its lines (every line is CANCELLED by the cancel)", () => {
    const out = orderAgainCartLines(
      [line({ status: "CANCELLED" }), line({ status: "CANCELLED", productId: "p2" })],
      "CANCELLED",
    );
    expect(out.map((l) => l.productId)).toEqual(["p1", "p2"]);
  });

  it("a CANCELLED order still skips custom lines (no product)", () => {
    const out = orderAgainCartLines(
      [line({ status: "CANCELLED", productId: null, product: null })],
      "CANCELLED",
    );
    expect(out).toEqual([]);
  });
});
