/**
 * B894 (SA-576): a return credit prices a SLICE of an already-billed line FROM SCRATCH, so it must be
 * ADDITIVE: the credits over any sequence of partial slices sum to the whole-line credit and never
 * exceed it. `prorateLineSubtotal`'s floored free-unit telescope is non-monotone point by point, so
 * used per slice it over-credits (size 1, BOGO, P=2, F=1, stored S: 1 piece credits S, the other
 * piece credits S again = 2S). The slice rule is LINEAR: roundMoney(S × c / P).
 */
import { priceMatchedChunk, type CandidateInvoiceLine } from "./inline-returns-pricing";

function line(o: Partial<CandidateInvoiceLine>): CandidateInvoiceLine {
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
    promoFreeUnits: null as number | null,
    taxRate: 0,
    categoryTax: null,
    invoiceSubtotal: 0,
    invoiceDiscount: 0,
    invoiceTaxAmount: 0,
    ...o,
  };
  const piecesQty = base.boxes != null ? base.qty : base.qty * (base.unitsPerBox || 1);
  return { ...base, piecesQty };
}

const credit = (l: CandidateInvoiceLine, chunks: number[]) =>
  chunks.map((c) => priceMatchedChunk(l, c, true).subtotal);
const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

describe("B894 — slice credits are additive (priceMatchedChunk)", () => {
  // [label, line, chunkings]
  const cases: Array<[string, CandidateInvoiceLine, number[][]]> = [
    [
      "size 1, BOGO: P=2, F=1, S=10 — the SA-576 case (returning 1 then 1 credits 2S today)",
      line({ qty: 2, subtotal: 10, promoFreeUnits: 1, unitPrice: 10 }),
      [[1, 1], [2]],
    ],
    [
      "size 4: S=24, P=20 pieces, F=2 boxes — chunks 9+9+2 credit 18+18+4=40 today",
      line({ boxes: 5, pieces: 0, unitsPerBox: 4, qty: 20, subtotal: 24, promoFreeUnits: 2 }),
      [[9, 9, 2], [10, 10], [1, 19], [20]],
    ],
    [
      "size 3, F=3: S=45, P=15",
      line({ boxes: 5, pieces: 0, unitsPerBox: 3, qty: 15, subtotal: 45, promoFreeUnits: 3 }),
      [[4, 4, 4, 3], [7, 8], [15]],
    ],
    [
      "no free units: linear already (the parity control, green at master)",
      line({ boxes: 5, pieces: 0, unitsPerBox: 4, qty: 20, subtotal: 100, promoFreeUnits: 0 }),
      [[9, 9, 2], [20]],
    ],
  ];

  it.each(cases)("%s", (_label, l, chunkings) => {
    for (const chunks of chunkings) {
      const parts = credit(l, chunks);
      // never exceeds the line, up to half a cent per chunk of rounding
      expect(sum(parts)).toBeLessThanOrEqual(l.subtotal + 0.005 * chunks.length);
      // and the whole-line credit is exactly the stored subtotal
      if (chunks.reduce((a, b) => a + b, 0) === l.piecesQty)
        expect(Math.abs(sum(parts) - l.subtotal)).toBeLessThanOrEqual(0.005 * chunks.length);
      for (const p of parts) expect(p).toBeGreaterThanOrEqual(0);
    }
  });

  it("the tax on a credit follows the same slice: no chunking credits more tax than the line carries", () => {
    const l = line({
      qty: 2,
      subtotal: 10,
      promoFreeUnits: 1,
      unitPrice: 10,
      taxRate: 0.1,
      invoiceTaxAmount: 1,
    });
    const tax = [1, 1].map((c) => priceMatchedChunk(l, c, false).taxAmount);
    expect(sum(tax)).toBeLessThanOrEqual(1 + 0.005 * 2);
  });
});
