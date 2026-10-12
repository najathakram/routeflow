import { orderPreviewTotalsRows } from "./order-preview-totals";

// The order preview must add up: Subtotal + Tax + each named charge - Discount + Shipping (+ a plain Adjustment for
// whatever the order's own header carries beyond those) = Order total.
describe("orderPreviewTotalsRows", () => {
  const crv = { key: "crv", label: "CRV deposit", amount: 2.8 };
  const sum = (rows: Array<{ amount: number }>) =>
    Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100;

  it("discount and shipping are their own rows and the parts add to the total", () => {
    const rows = orderPreviewTotalsRows({
      subtotal: 40,
      tax: 3.3,
      charges: [crv],
      discountAmount: 5,
      shippingFee: "4.00",
      total: 45.1,
    });
    expect(rows.map((r) => [r.key, r.amount])).toEqual([
      ["subtotal", 40],
      ["tax", 3.3],
      ["charge-crv", 2.8],
      ["discount", -5],
      ["shipping", 4],
    ]);
    expect(sum(rows)).toBe(45.1);
  });

  it("an edited order's header that never subtracted its discount still adds up: the gap is a named Adjustment", () => {
    // 40 + 3.30 + 4.00 shipping = 47.30 is what the edit stored; the stored discountAmount (5) was not applied
    const rows = orderPreviewTotalsRows({
      subtotal: 40,
      tax: 3.3,
      charges: [],
      discountAmount: 5,
      shippingFee: 4,
      total: 47.3,
    });
    expect(sum(rows)).toBe(47.3);
    expect(rows.map((r) => r.key)).toEqual([
      "subtotal",
      "tax",
      "discount",
      "shipping",
      "adjustment",
    ]);
    expect(rows.find((r) => r.key === "adjustment")?.amount).toBe(5);
  });

  it("a plain order is Subtotal and Tax only", () => {
    const rows = orderPreviewTotalsRows({ subtotal: 20, tax: 1.65, charges: [], total: 21.65 });
    expect(rows.map((r) => r.key)).toEqual(["subtotal", "tax"]);
    expect(sum(rows)).toBe(21.65);
  });

  it("an untaxed order still shows the Tax row at $0.00 as it always did", () => {
    const rows = orderPreviewTotalsRows({ subtotal: 20, tax: 0, charges: [], total: 20 });
    expect(rows.find((r) => r.key === "tax")?.amount).toBe(0);
  });
});
