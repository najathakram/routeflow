import { MoneyInvariantError } from "./money-invariants";
import {
  refundableLineShare,
  refundableProductPoolShare,
  taxRateMicros,
  type RefundableInvoice,
  type RefundableInvoiceLine,
} from "./refundable-line-share";

/**
 * SA-840 R1-R7 (B704 / #1477): ONE helper prices a return slice of an invoice line as what the invoice CHARGED:
 * net (less the line's invoice-discount share) + the line's regular-tax share + its category-tax (levy) share.
 * Every "wrong today" value below is what master's net-only pricer returns for the same input.
 */
const line = (
  id: string,
  subtotal: number,
  qty: number,
  taxRate: number,
  categoryTaxAmount = 0,
  isNsf = false,
): RefundableInvoiceLine => ({ id, subtotal, qty, taxRate, categoryTaxAmount, isNsf });

const NONE = { qty: 0, net: 0, tax: 0, categoryTax: 0 };

/** The R1 fixture: line 50.00 net (10 pcs), 8% = 4.00, levy 10.00, invoice 64.00. */
const r1Invoice = (): RefundableInvoice => ({
  taxAmount: 14,
  discount: 0,
  lines: [line("l1", 50, 10, 0.08, 10)],
});

describe("refundableLineShare (SA-840)", () => {
  it("REG-B704 R1: a full return of a taxed line refunds what the invoice charged", () => {
    // wrong today: 50.00 (net only; the 4.00 tax and the 10.00 levy are never refunded)
    const out = refundableLineShare({
      invoice: r1Invoice(),
      lineId: "l1",
      returnedQty: 10,
      prior: NONE,
    });
    expect(out).toEqual({ net: 50, tax: 4, categoryTax: 10, total: 64 });
    expect(out.refusal).toBeUndefined();
  });

  it("REG-B704 R2: 5 of 10, then the other 5, pay 32.00 + 32.00 and never 64.01", () => {
    // wrong today: 25.00 + 25.00
    const first = refundableLineShare({
      invoice: r1Invoice(),
      lineId: "l1",
      returnedQty: 5,
      prior: NONE,
    });
    expect(first).toEqual({ net: 25, tax: 2, categoryTax: 5, total: 32 });
    const second = refundableLineShare({
      invoice: r1Invoice(),
      lineId: "l1",
      returnedQty: 5,
      prior: { qty: 5, net: first.net, tax: first.tax, categoryTax: first.categoryTax },
    });
    expect(second).toEqual({ net: 25, tax: 2, categoryTax: 5, total: 32 });
    expect(first.total + second.total).toBe(64);
  });

  it("REG-B704 R3: a boxed line refunds 25.92 for one of two boxes, never 12 x 24 = 288", () => {
    // wrong today: 24.00 (net only). Line: 2 boxes x 12 = 24 pieces, stored subtotal 48.00 (computeLineSubtotal's
    // output), 8% = 3.84. One box back = 12 pieces on the line's own axis.
    const invoice: RefundableInvoice = {
      taxAmount: 3.84,
      discount: 0,
      lines: [line("box", 48, 24, 0.08)],
    };
    const out = refundableLineShare({ invoice, lineId: "box", returnedQty: 12, prior: NONE });
    expect(out).toEqual({ net: 24, tax: 1.92, categoryTax: 0, total: 25.92 });
  });

  it("REG-B704 R4: an exempt customer's invoice (tax 0, line rate 0.08 kept) refunds 50.00, not 54.00", () => {
    // wrong today: 50.00 is right here (guard); a rate-only derivation would give 54.00
    const invoice: RefundableInvoice = {
      taxAmount: 0,
      discount: 0,
      lines: [line("l1", 50, 10, 0.08, 0)],
    };
    const out = refundableLineShare({ invoice, lineId: "l1", returnedQty: 10, prior: NONE });
    expect(out).toEqual({ net: 50, tax: 0, categoryTax: 0, total: 50 });
  });

  it("REG-B704 R5: an invoice discount is deducted over the GOODS lines only and the NSF fee is never credited", () => {
    // wrong today: 50.00 (no discount share). Goods 50.00 @ 8% = 4.00, discount 5.00, NSF fee 25.00 (rate 0):
    // invoice total 74.00. Over ALL lines the discount share would be 3.33 and the refund 50.67.
    const invoice: RefundableInvoice = {
      taxAmount: 4,
      discount: 5,
      lines: [line("goods", 50, 10, 0.08), line("fee", 25, 1, 0, 0, true)],
    };
    const goods = refundableLineShare({ invoice, lineId: "goods", returnedQty: 10, prior: NONE });
    expect(goods).toEqual({ net: 45, tax: 4, categoryTax: 0, total: 49 });
    const fee = refundableLineShare({ invoice, lineId: "fee", returnedQty: 1, prior: NONE });
    expect(fee).toEqual({ net: 0, tax: 0, categoryTax: 0, total: 0 });
  });

  it("REG-B704 R7: three lines of 3.33 at 10% share the 1.00 invoice tax 0.34 / 0.33 / 0.33 (10.99, not 10.98)", () => {
    // wrong today: 9.99 (net only). Per-line roundMoney(s x r) gives 0.33 x 3 = 0.99, one cent short of the 1.00 charged.
    const invoice: RefundableInvoice = {
      taxAmount: 1,
      discount: 0,
      lines: [line("p1", 3.33, 1, 0.1), line("p2", 3.33, 1, 0.1), line("p3", 3.33, 1, 0.1)],
    };
    const price = (lineId: string) =>
      refundableLineShare({ invoice, lineId, returnedQty: 1, prior: NONE });
    const [p1, p2, p3] = [price("p1"), price("p2"), price("p3")];
    expect([p1.tax, p2.tax, p3.tax]).toEqual([0.34, 0.33, 0.33]);
    expect(p1.total).toBe(3.67);
    expect(Math.round((p2.total + p3.total) * 100) / 100).toBe(7.32);
    expect(Math.round((p1.total + p2.total + p3.total) * 100) / 100).toBe(10.99);
  });

  it("REG-B704 mixed rates: the regular tax is split by subtotal x rate, summing to the stored tax exactly", () => {
    // wrong today: net only. 10.00 @ 10% (1.00) + 30.00 @ 5% (1.50) = 2.50 stored
    const invoice: RefundableInvoice = {
      taxAmount: 2.5,
      discount: 0,
      lines: [line("a", 10, 1, 0.1), line("b", 30, 1, 0.05)],
    };
    const a = refundableLineShare({ invoice, lineId: "a", returnedQty: 1, prior: NONE });
    const b = refundableLineShare({ invoice, lineId: "b", returnedQty: 1, prior: NONE });
    expect([a.tax, b.tax]).toEqual([1, 1.5]);
  });

  it("REG-B704 refuses (never clips) a slice past the line's qty", () => {
    // wrong today: master's pricer clips to min(returned, billed) without saying so
    const out = refundableLineShare({
      invoice: r1Invoice(),
      lineId: "l1",
      returnedQty: 3,
      prior: { qty: 8, net: 40, tax: 3.2, categoryTax: 8 },
    });
    expect(out.refusal).toBeDefined();
    expect(out.total).toBe(0);
  });

  it("REG-B704 a line that is not on the invoice is a refusal, not the first line", () => {
    const out = refundableLineShare({
      invoice: r1Invoice(),
      lineId: "nope",
      returnedQty: 1,
      prior: NONE,
    });
    expect(out.refusal).toBeDefined();
    expect(out.total).toBe(0);
  });

  it("REG-B704 a missing or non-finite pool throws MoneyInvariantError (no fail-open 0)", () => {
    // wrong today: there is no helper; a select that forgot taxAmount would price tax as 0
    const missingTax = { ...r1Invoice(), taxAmount: undefined } as unknown as RefundableInvoice;
    const nanDiscount = { ...r1Invoice(), discount: Number.NaN } as RefundableInvoice;
    const nullDiscount = { ...r1Invoice(), discount: null } as unknown as RefundableInvoice;
    for (const invoice of [missingTax, nanDiscount, nullDiscount]) {
      expect(() =>
        refundableLineShare({ invoice, lineId: "l1", returnedQty: 1, prior: NONE }),
      ).toThrow(MoneyInvariantError);
    }
  });

  it("taxRateMicros reads a Decimal(9,6) rate as integer micro-units without float noise", () => {
    expect(taxRateMicros(0.08)).toBe(80000);
    expect(taxRateMicros("0.0825")).toBe(82500);
    expect(taxRateMicros(0.070625)).toBe(70625);
    expect(taxRateMicros(null)).toBe(0);
    expect(() => taxRateMicros(Number.NaN)).toThrow(MoneyInvariantError);
  });
});

/**
 * SA-970 (amends SA-840 section 2): a return item that names only the PRODUCT is sliced over the product's pool on the
 * invoice, one virtual line per invoice and product; an item that names its line keeps SA-840's per-line slice.
 */
describe("refundableProductPoolShare (SA-970)", () => {
  // paid line 10 pcs at 100.00 + free line 2 pcs, 8%: the pool is 12 pieces, net 100.00, tax 8.00
  const promo = (): RefundableInvoice => ({
    taxAmount: 8,
    discount: 0,
    lines: [line("paid", 100, 10, 0.08), line("free", 0, 2, 0.08)],
  });
  // two lines of one product at different prices, 8%: pool net 150.00, tax 12.00 over 2 pieces
  const split = (): RefundableInvoice => ({
    taxAmount: 12,
    discount: 0,
    lines: [line("dear", 100, 1, 0.08), line("cheap", 50, 1, 0.08)],
  });
  const at = (id: string, pieces: number, prior = NONE) => ({ id, pieces, prior });

  it("REG-B704 SA-970 pool slice: 11 of 12 pieces is 91.67 net + 7.33 tax, spread on the paid line, the free line gets 0", () => {
    // wrong today: there is no pool function; a per-line slice of the paid line alone refunds the whole 100.00 + 8.00
    const out = refundableProductPoolShare({
      invoice: promo(),
      lines: [at("paid", 10), at("free", 2)],
      returnedPieces: 11,
    });
    expect([out.net, out.tax, out.categoryTax, out.total]).toEqual([91.67, 7.33, 0, 99]);
    expect(out.spread).toEqual([
      { id: "paid", net: 91.67, tax: 7.33, categoryTax: 0, total: 99 },
      { id: "free", net: 0, tax: 0, categoryTax: 0, total: 0 },
    ]);
  });

  it("REG-B704 SA-970 the pool telescopes: 11 of 12 and then the last 1 sum to the pool exactly (100.00 / 8.00)", () => {
    // wrong today: no pool function
    const second = refundableProductPoolShare({
      invoice: promo(),
      lines: [
        at("paid", 10, { qty: 10, net: 91.67, tax: 7.33, categoryTax: 0 }),
        at("free", 2, { qty: 1, net: 0, tax: 0, categoryTax: 0 }),
      ],
      returnedPieces: 1,
    });
    expect([second.net, second.tax]).toEqual([8.33, 0.67]);
    expect(roundCents(91.67 + second.net)).toBe(100);
    expect(roundCents(7.33 + second.tax)).toBe(8);
  });

  it("REG-B704 SA-970 two lines of one product: 1 of 2 pieces is 75.00 + 6.00, itemised on the dear line first", () => {
    // wrong today: a per-line slice of the first line refunds 100.00 + 8.00
    const out = refundableProductPoolShare({
      invoice: split(),
      lines: [at("dear", 1), at("cheap", 1)],
      returnedPieces: 1,
    });
    expect([out.net, out.tax]).toEqual([75, 6]);
    expect(out.spread.map((l) => [l.id, l.net, l.tax])).toEqual([
      ["dear", 75, 6],
      ["cheap", 0, 0],
    ]);
  });

  it("REG-B704 SA-970 an item that NAMES its line is sliced on that line (SA-840): the cheap line is 50.00 + 4.00", () => {
    // wrong today: the cheap line priced at the pooled 75.00
    const out = refundableLineShare({
      invoice: split(),
      lineId: "cheap",
      returnedQty: 1,
      prior: NONE,
    });
    expect([out.net, out.tax, out.total]).toEqual([50, 4, 54]);
  });

  it("REG-B704 SA-970 a pool of one line is exactly refundableLineShare (R1: 5 of 10 is 25 / 2 / 5)", () => {
    // wrong today: no pool function
    const pooled = refundableProductPoolShare({
      invoice: r1Invoice(),
      lines: [at("l1", 10)],
      returnedPieces: 5,
    });
    expect([pooled.net, pooled.tax, pooled.categoryTax, pooled.total]).toEqual([25, 2, 5, 32]);
  });

  it("REG-B704 SA-970 each line takes no more than its room: a credited dear line pushes the slice onto the cheap one", () => {
    // wrong today: no pool function. dear is fully credited (100.00 / 8.00), 1 of 2 pieces left in the pool: min(75, 50) = 50
    const out = refundableProductPoolShare({
      invoice: split(),
      lines: [at("dear", 1, { qty: 1, net: 100, tax: 8, categoryTax: 0 }), at("cheap", 1)],
      returnedPieces: 1,
    });
    expect(out.spread.map((l) => [l.id, l.net, l.tax])).toEqual([
      ["dear", 0, 0],
      ["cheap", 50, 4],
    ]);
    expect(out.net).toBe(50);
  });

  it("REG-B704 SA-970 a qty past the pool is refused, never clipped; a line off the invoice is refused", () => {
    // wrong today: no pool function
    expect(
      refundableProductPoolShare({
        invoice: promo(),
        lines: [at("paid", 10), at("free", 2)],
        returnedPieces: 13,
      }).refusal,
    ).toBe("QTY_OVER_LINE");
    expect(
      refundableProductPoolShare({ invoice: promo(), lines: [at("nope", 1)], returnedPieces: 1 })
        .refusal,
    ).toBe("LINE_NOT_ON_INVOICE");
  });

  it("REG-B704 SA-970 a missing pool throws MoneyInvariantError", () => {
    // wrong today: no pool function
    const bad = { ...promo(), taxAmount: undefined } as unknown as RefundableInvoice;
    expect(() =>
      refundableProductPoolShare({ invoice: bad, lines: [at("paid", 10)], returnedPieces: 1 }),
    ).toThrow(MoneyInvariantError);
  });
});

const roundCents = (n: number): number => Math.round(n * 100) / 100;
