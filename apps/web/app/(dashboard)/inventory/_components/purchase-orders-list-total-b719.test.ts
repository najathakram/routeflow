/**
 * B719 (#1485): a purchase-order LIST row's total. The API returns the raw Prisma
 * `PurchaseOrder.totalAmount` (a numeric STRING); the web type declared a `total` it never sends,
 * so every row showed $0.00. `poListTotal` mirrors the mobile list's `poDisplayTotal` rule.
 */
import { poListTotal } from "./purchase-orders-shared";

const line = (totalCost: string | undefined, over: Record<string, unknown> = {}) => ({
  id: "i",
  productId: "p",
  qtyOrdered: "1",
  qtyReceived: "0",
  unitCost: "1.0000",
  totalCost,
  ...over,
});

describe("poListTotal (B719)", () => {
  it.each([
    ["a numeric string", "123.45", 123.45],
    ["a number", 88, 88],
    ["a string with extra precision (rounded to cents)", "10.005", 10.01],
  ])("the stored totalAmount as %s", (_label, totalAmount, want) => {
    expect(poListTotal({ totalAmount, items: [line("999.00")] })).toBe(want);
  });

  it.each([null, undefined, "0", "0.00", "", "abc", "-5"])(
    "no usable stored total (%j) ⇒ the sum of the lines' STORED totals",
    (totalAmount) => {
      expect(
        poListTotal({
          totalAmount: totalAmount as any,
          items: [line("30.00"), line("12.50", { packSize: 12, qtyOrdered: "12" })],
        }),
      ).toBe(42.5);
    },
  );

  it("no stored total and no lines ⇒ 0", () => {
    expect(poListTotal({ totalAmount: null, items: [] })).toBe(0);
  });
});
