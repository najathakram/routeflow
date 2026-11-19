// REG-B752: updateOrderItems and the change-request merge re-totalled an order with NO discount term, so every edit of a discounted
// order overstated Order.total by exactly discountAmount (and fed that too-high figure to the credit gate). Both edit paths now
// call editedOrderTotals (W-762, eef55bcdce), which applies the order's STORED discountAmount: the wrong value is total = subtotal + shipping.
import { readFileSync } from "fs";
import { join } from "path";
import { editedOrderTotals } from "./order-totals";

describe("REG-B752: an edit re-total keeps the order discount", () => {
  const order = { discountAmount: "10.00", createdAt: new Date() };
  const lines = [{ subtotal: 60 }, { subtotal: 40 }];
  const base = { taxRate: 0, isTaxExempt: false, shipping: 5, subtotal: 100 };

  it("REG-B752: a discounted order re-totals to subtotal - discount + shipping, not the undiscounted 105", () => {
    const totals = editedOrderTotals(lines, order, base);
    expect(totals.total).not.toBe(105);
    expect(totals.total).toBe(95);
  });

  it("REG-B752: the discount is read from the stored order each time, so a no-discount order is untouched", () => {
    expect(editedOrderTotals(lines, { createdAt: new Date() }, base).total).toBe(105);
    expect(
      editedOrderTotals(lines, { discountAmount: null, createdAt: new Date() }, base).total,
    ).toBe(105);
  });

  it("REG-B752: taxed lines still carry the discount (tax never pushes the total back to the undiscounted figure)", () => {
    const totals = editedOrderTotals(lines, order, { ...base, taxRate: 0.1 });
    const undiscounted = editedOrderTotals(
      lines,
      { createdAt: new Date() },
      {
        ...base,
        taxRate: 0.1,
      },
    );
    expect(totals.total).toBeLessThan(undiscounted.total);
    expect(totals.total).toBeLessThanOrEqual(undiscounted.total - 10 + 0.01);
  });

  // The helper alone is not the fix: both edit paths (updateOrderItems, the change-request apply) must still route their
  // re-total through it with the STORED order, the one carrying discountAmount. A call site that sums by hand, or passes
  // no order, drops the discount again (the B752 wrong value).
  it("REG-B752: updateOrderItems and the change-request apply both re-total through editedOrderTotals with the stored order", () => {
    const src = readFileSync(join(__dirname, "orders.service.ts"), "utf8");
    const calls = [...src.matchAll(/editedOrderTotals\(\s*activeItems,\s*(\w+),/g)].map(
      (m) => m[1],
    );
    expect(calls).toEqual(["order", "live"]);
    expect(src).not.toMatch(/subtotal\s*\+\s*tax\s*\+\s*categoryTax\s*\+\s*shippingFee/);
  });
});
