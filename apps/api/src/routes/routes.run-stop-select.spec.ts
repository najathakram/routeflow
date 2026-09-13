/**
 * REG-B305: the driver run/stop payload must project the order's subtotal/tax/total
 * so the mobile app can quote and collect the tax-inclusive amount due, not just the
 * pre-tax line subtotal (`RUN_LINE_ITEMS_SELECT` has no tax field at all). Today
 * `RUN_STOP_INCLUDE` is a module-internal `const` in `routes.service.ts` (not
 * exported) — this import is red until the fix exports it.
 */
import { InvoiceStatus } from "@prisma/client";
import { RUN_LINE_ITEMS_SELECT, RUN_STOP_INCLUDE } from "./routes.service";

describe("REG-B305 driver run/stop order projection", () => {
  it("REG-B305 the driver run/stop payload projects the order's subtotal, tax and total", () => {
    expect(RUN_STOP_INCLUDE.orders.select).toEqual(
      expect.objectContaining({ subtotal: true, tax: true, total: true }),
    );
    expect(RUN_STOP_INCLUDE.orders.select.lineItems).toEqual({
      select: RUN_LINE_ITEMS_SELECT,
    });
  });

  // Order.total carries no discount (it is not re-derived on write), so the
  // driver's at-door amount due must come from the order's OPEN DRAFT
  // invoice — the figure that is actually billed — not Order.subtotal/tax/total
  // alone. Red until RUN_STOP_INCLUDE also selects discountAmount/shippingFee
  // on the order and the open-draft invoice relation.
  it("REG-B305 the driver run/stop payload projects the order's discount/shipping and its open draft invoice totals", () => {
    expect(RUN_STOP_INCLUDE.orders.select.discountAmount).toBe(true);
    expect(RUN_STOP_INCLUDE.orders.select.shippingFee).toBe(true);
    expect(RUN_STOP_INCLUDE.orders.select.invoices).toEqual({
      where: { status: InvoiceStatus.DRAFT, deliveryBatchId: null },
      select: {
        id: true,
        subtotal: true,
        taxAmount: true,
        discount: true,
        shippingFee: true,
        total: true,
      },
      take: 1,
    });
  });
});
