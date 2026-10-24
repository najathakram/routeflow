import { invoiceItemDto, invoiceItemOverride } from "../lib/invoice-unit-pick";

/**
 * H3b: POST /invoices judges a typed price against the customer's TIER price exactly like POST
 * /orders/sell (one rule, @routeflow/pricing's decideStaffOverride). The New-invoice screen decides
 * what to SEND with the same decision it already makes for a sale: the trimmed reason when the price
 * moved off the tier price, nothing when it did not, and a refusal (the screen blocks the save,
 * naming the product) off a special price with no reason.
 */
const ctx = { catalogPrice: 20, listPrice: 24, isSpecial: true }; // tier-3: $20 against a $24 list

describe("invoiceItemOverride — the reason a POST /invoices line carries (H3b)", () => {
  it("the tier price itself needs no reason and sends none", () => {
    expect(invoiceItemOverride({ qty: 3 }, ctx)).toEqual({});
    // within half a cent of the tier price is no override
    expect(invoiceItemOverride({ qty: 3, unitPrice: 20.004, overrideReason: "x" }, ctx)).toEqual(
      {},
    );
  });

  it("off a special price with NO reason is refused (the screen blocks the save)", () => {
    expect(invoiceItemOverride({ qty: 3, unitPrice: 24 }, ctx)).toEqual({ refused: true });
    expect(invoiceItemOverride({ qty: 3, unitPrice: 24, overrideReason: "   " }, ctx)).toEqual({
      refused: true,
    });
  });

  it("off a special price WITH a reason sends the trimmed reason", () => {
    expect(
      invoiceItemOverride({ qty: 3, unitPrice: 24, overrideReason: "  agreed at list " }, ctx),
    ).toEqual({ overrideReason: "agreed at list" });
  });

  it("a plain tier-1 customer needs no reason to move the price, and a typed one is still sent", () => {
    const tier1 = { catalogPrice: 24, listPrice: 24, isSpecial: false };
    expect(invoiceItemOverride({ qty: 3, unitPrice: 20 }, tier1)).toEqual({});
    expect(
      invoiceItemOverride({ qty: 3, unitPrice: 20, overrideReason: "damaged" }, tier1),
    ).toEqual({ overrideReason: "damaged" });
  });

  it("a unit line is judged against the unit's own price, not the pack's", () => {
    const line = { qty: 3, unitLabel: "Case", unitPrice: 24, unitListPrice: 24 };
    const unitCtx = { catalogPrice: 20, listPrice: 99, isSpecial: true };
    expect(invoiceItemOverride(line, unitCtx)).toEqual({ refused: true });
    expect(invoiceItemOverride({ ...line, overrideReason: "agreed at list" }, unitCtx)).toEqual({
      overrideReason: "agreed at list",
    });
    expect(invoiceItemOverride({ ...line, unitPrice: 20 }, unitCtx)).toEqual({});
  });

  it("merges onto the invoice item without disturbing the effective price it already sends", () => {
    const line = { qty: 3, unitPrice: 24, overrideReason: "agreed at list" };
    const over = invoiceItemOverride(line, ctx);
    const dto = {
      ...invoiceItemDto(line, { id: "p1", description: "Widget" }, 20, null, 0),
      ...over,
    };
    expect(dto).toMatchObject({
      productId: "p1",
      qty: 3,
      unitPrice: 24,
      overrideReason: "agreed at list",
    });
  });
});
