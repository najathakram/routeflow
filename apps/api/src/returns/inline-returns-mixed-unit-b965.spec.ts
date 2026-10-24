/**
 * B965 (SA-628l): the safe way to credit a product sold in two units on one order is the INLINE per-line return: each chunk
 * names its own source line and prices off THAT line (a pooled average would price 12 pieces of the dear box line like the cheap
 * loose line). Literal oracles for 2 boxes of 12 @ $300 beside 12 loose pieces @ $60.
 */
import {
  priceMatchedChunk,
  returnRequestPieces,
  type CandidateInvoiceLine,
} from "./inline-returns-pricing";

/** A fully-specified candidate line with sane defaults, overridden per test. `piecesQty`
 * auto-derives from qty/boxes/unitsPerBox (the same rule the real caller uses) unless the
 * override supplies it explicitly. */
function line(overrides: Partial<CandidateInvoiceLine>): CandidateInvoiceLine {
  const base = {
    sourceOrderId: "order-1",
    sourceInvoiceItemId: "item-1",
    sourceOrderItemId: "oi-1",
    productId: "prod-1",
    qty: 0,
    unitPrice: 0,
    subtotal: 0,
    boxes: null as number | null,
    pieces: null as number | null,
    unitsPerBox: null as number | null,
    promoFreeUnits: null,
    taxRate: 0,
    categoryTax: null,
    invoiceSubtotal: 0,
    invoiceDiscount: 0,
    invoiceTaxAmount: 0,
    ...overrides,
  };
  const piecesQty =
    overrides.piecesQty ?? (base.boxes != null ? base.qty : base.qty * (base.unitsPerBox || 1));
  return { ...base, piecesQty };
}

describe("inline per-line return of a mixed-unit product prices each line on its own (B965)", () => {
  const boxLine = line({
    sourceInvoiceItemId: "item-box",
    boxes: null,
    pieces: null,
    unitsPerBox: 12,
    qty: 2,
    unitPrice: 150,
    subtotal: 300,
  });
  const looseLine = line({
    sourceInvoiceItemId: "item-loose",
    boxes: 0,
    pieces: 12,
    unitsPerBox: 12,
    qty: 12,
    unitPrice: 5,
    subtotal: 60,
  });

  it("12 pieces back off the box line = half the line = $150.00 (a pooled average would say $120.00)", () => {
    const pieces = returnRequestPieces({ qty: 0, boxes: 0, pieces: 12, unitsPerBox: 12 });
    expect(pieces).toBe(12);
    expect(priceMatchedChunk(boxLine, pieces, false).subtotal).toBe(150.0);
    expect(priceMatchedChunk(boxLine, pieces, false).subtotal).not.toBe(120.0);
  });

  it("12 pieces back off the loose line = the whole line = $60.00", () => {
    expect(priceMatchedChunk(looseLine, 12, false).subtotal).toBe(60.0);
  });

  it("both chunks together credit $210.00, never more than the lines' own $360.00 for 24 pieces", () => {
    const total =
      priceMatchedChunk(boxLine, 12, false).subtotal +
      priceMatchedChunk(looseLine, 12, false).subtotal;
    expect(total).toBe(210.0);
    expect(total).toBeLessThanOrEqual(360);
  });
});
