import { MoneyInvariantError } from "./money-invariants";
import {
  refundableLineShare,
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
