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
      orderBy: { createdAt: "asc" },
    });
  });

  // B305 round 2 (RULING 1): a regulated SEPARATE_INVOICE order's
  // `reconcileSplitOrderDrafts` can leave it with SEVERAL open drafts (base +
  // `-R#` siblings) — `take: 1` silently dropped every sibling but the oldest
  // and under-charged the driver. `orderBy: createdAt asc` (no `take`) mirrors
  // `findOpenOrderDraft`/`reconcileSplitOrderDrafts` (invoices.service.ts) so
  // every open draft is projected, oldest first.
  it("REG-B305 RULING 1: projects ALL open drafts (never `take: 1`), oldest first", () => {
    expect((RUN_STOP_INCLUDE.orders.select.invoices as any).take).toBeUndefined();
    expect(RUN_STOP_INCLUDE.orders.select.invoices.orderBy).toEqual({ createdAt: "asc" });
  });

  // B305 round 2 (RULING 1/3): the delivered-basis short-pick estimate needs
  // each line's regulated-category tax snapshot to reproduce
  // invoices.service.ts#buildInvoiceItemData's own per-unit proration
  // (mobile's run-money.ts#deliveredCategoryTax). `OrderItem` (sales.prisma)
  // has NO `taxRate` column — only `categoryTaxAmount` — so that field alone
  // is added here.
  it("REG-B305 RULING 1/3: the line items select carries the per-line category tax snapshot", () => {
    expect(RUN_LINE_ITEMS_SELECT.categoryTaxAmount).toBe(true);
  });

  // B305 round 3 (Opus): the driver's short-pick estimate must zero tax for an
  // exempt customer exactly as reconcileOrderDraftInvoice does
  // (invoices.service.ts ~1493-1495: `select: { isTaxExempt: true }` ->
  // `isTaxExempt = !!customer?.isTaxExempt`) — without this column projected
  // on the stop's customer, the mobile helper has no way to know the customer
  // is exempt and over-collects at the door on a partial delivery.
  it("REG-B305 round 3: the stop's customer select carries the tax-exemption column", () => {
    expect(RUN_STOP_INCLUDE.customer.select.isTaxExempt).toBe(true);
  });
});
