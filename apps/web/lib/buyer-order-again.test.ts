import { ORDER_AGAIN_STATUSES, orderAgainCartLines } from "./buyer-order-again";

// SA-1101 T: a refused order is a past order like a delivered or cancelled one, read through the shared terminal list.
describe("ORDER_AGAIN_STATUSES", () => {
  it("covers every done order (delivered, refused, cancelled) and a partly delivered one, not an open one", () => {
    expect([...ORDER_AGAIN_STATUSES].sort()).toEqual(
      ["CANCELLED", "DELIVERED", "PARTIALLY_DELIVERED", "REFUSED"].sort(),
    );
    for (const open of ["DRAFT", "PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"]) {
      expect(ORDER_AGAIN_STATUSES).not.toContain(open);
    }
  });
});

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

// B1409: one product is one line, so a repeated line is folded in pieces and the cart shows one limit line.
describe("orderAgainCartLines folds same-product lines (B1409)", () => {
  it("two lines of one product become one line with the summed pieces, uncapped (the cart clamps it)", () => {
    const out = orderAgainCartLines([line({ qty: 60_000 }), line({ qty: 60_000 })]);
    expect(out).toHaveLength(1);
    expect(out[0].qty).toBe(120_000);
  });

  it("keeps different products apart in first-seen order", () => {
    const out = orderAgainCartLines([
      line({ productId: "a", qty: 1 }),
      line({ productId: "b", qty: 2 }),
      line({ productId: "a", qty: 3 }),
    ]);
    expect(out.map((l) => [l.productId, l.qty])).toEqual([
      ["a", 4],
      ["b", 2],
    ]);
  });

  it("re-derives the box split on a folded boxed line", () => {
    const boxed = { name: "Case widget", unit: "each", unitsPerBox: 12 };
    const out = orderAgainCartLines([
      line({ productId: "c", qty: 12, product: boxed }),
      line({ productId: "c", qty: 24, product: boxed }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].qty).toBe(36);
    expect(out[0].boxes).toBe(3);
    expect(out[0].pieces).toBe(0);
  });
});
