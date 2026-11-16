import {
  DISCOUNT_PRE_TAX_FROM,
  DISCOUNT_TAX_BASE_VALUES,
  LEGACY_DISCOUNT_BASE,
  discountTaxBaseOf,
  taxRateBaseOf,
} from "./discount-tax-base";
import { computeInvoiceTotals, sumInvoiceTotals, type SummedInvoiceLine } from "./invoice-totals";
import { inferredGoodsFlatRate } from "./nsf-line";
import { MoneyInvariantError } from "./money-invariants";
import { refundableLineShare } from "./refundable-line-share";
import { roundMoney } from "./pricing";
import { saleTotals } from "./sale-totals";

/**
 * SA-1141 / W-989: an invoice-level discount comes off BEFORE sales tax, spread pro-rata over ALL goods lines
 * by subtotal, in mode PRE_TAX. Master's values (observed by running the built `sumInvoiceTotals`) are the
 * "wrong value" each PRE_TAX case must be red on. LEGACY_POST_TAX is master's formula, byte for byte.
 */
const PRE = "PRE_TAX" as const;
const LEGACY = "LEGACY_POST_TAX" as const;

const A: SummedInvoiceLine[] = [{ subtotal: 100, taxRate: 0.1 }];
const B: SummedInvoiceLine[] = [
  { subtotal: 100, taxRate: 0.05 },
  { subtotal: 200, taxRate: 0.1 },
];
const C: SummedInvoiceLine[] = [
  { subtotal: 100, taxRate: 0.0825 },
  { subtotal: 100, taxRate: 0 },
];
const D: SummedInvoiceLine[] = [{ subtotal: 50, taxRate: 0.0825, categoryTaxAmount: 6 }];
const E: SummedInvoiceLine[] = [{ subtotal: 10, taxRate: 0.0825 }];
const F: SummedInvoiceLine[] = [
  { subtotal: 33.33, taxRate: 0.0825 },
  { subtotal: 66.67, taxRate: 0.0825 },
];

describe("sumInvoiceTotals PRE_TAX (SA-1141 cases 1-5)", () => {
  it("case 1: 100 @10% with 20 off taxes the 80 (master: 10 / 90)", () => {
    const t = sumInvoiceTotals(A, { discount: 20, discountBase: PRE });
    expect(t.regularTax).toBe(8);
    expect(t.total).toBe(88);
  });

  it("case 2: mixed rates share one factor (master: 25 / 295)", () => {
    const t = sumInvoiceTotals(B, { discount: 30, discountBase: PRE });
    expect(t.regularTax).toBe(22.5);
    expect(t.total).toBe(292.5);
  });

  it("case 3: a non-taxable goods line takes its share too, so 7.43 and NOT the taxable-only 6.60 (master: 8.25 / 188.25)", () => {
    const t = sumInvoiceTotals(C, { discount: 20, discountBase: PRE });
    expect(t.regularTax).toBe(7.43);
    expect(t.total).toBe(187.43);
    expect(t.regularTax).not.toBe(6.6);
  });

  it("case 4: the levy is untouched by the discount (master: 4.13 / 50.13)", () => {
    const t = sumInvoiceTotals(D, { discount: 10, discountBase: PRE });
    expect(t.regularTax).toBe(3.3);
    expect(t.categoryTax).toBe(6);
    expect(t.total).toBe(49.3);
  });

  it("case 5: a discount above the subtotal clamps the base at 0, tax never negative (master: 0.83)", () => {
    const t = sumInvoiceTotals(E, { discount: 12, discountBase: PRE });
    expect(t.regularTax).toBe(0);
    expect(t.total).toBe(-2);
  });

  it("F: the tax is summed unrounded and rounded once (8.17 / 107.17; master 8.25 / 107.25)", () => {
    const t = sumInvoiceTotals(F, { discount: 1, discountBase: PRE });
    expect(t.regularTax).toBe(8.17);
    expect(t.total).toBe(107.17);
  });

  it("an exempt customer owes 0 of both taxes in PRE_TAX too", () => {
    const t = sumInvoiceTotals(D, { discount: 10, discountBase: PRE, isTaxExempt: true });
    expect(t.tax).toBe(0);
    expect(t.total).toBe(40);
  });

  it("no discount: PRE_TAX equals LEGACY exactly", () => {
    expect(sumInvoiceTotals(B, { discountBase: PRE })).toEqual(
      sumInvoiceTotals(B, { discountBase: LEGACY }),
    );
  });

  it("a NSF fee line is outside the goods split: it neither takes a share nor dilutes the factor", () => {
    const lines: SummedInvoiceLine[] = [
      { subtotal: 100, taxRate: 0.1 },
      { subtotal: 25, taxRate: 0, isNsf: true },
    ];
    // goods S = 100, f = 0.8: tax 8 (a 125 base would give f = 0.84 and tax 8.40)
    const t = sumInvoiceTotals(lines, { discount: 20, discountBase: PRE });
    expect(t.regularTax).toBe(8);
    expect(t.total).toBe(roundMoney(125 - 20 + 8));
  });
});

describe("sumInvoiceTotals LEGACY_POST_TAX and the required mode (cases 6, 7)", () => {
  it("case 6: LEGACY is master's formula (10 / 90)", () => {
    const t = sumInvoiceTotals(A, { discount: 20, discountBase: LEGACY });
    expect(t).toEqual({ subtotal: 100, regularTax: 10, categoryTax: 0, tax: 10, total: 90 });
  });

  it("LEGACY pins master's other fixtures byte for byte", () => {
    expect(sumInvoiceTotals(B, { discount: 30, discountBase: LEGACY })).toMatchObject({
      regularTax: 25,
      total: 295,
    });
    expect(sumInvoiceTotals(C, { discount: 20, discountBase: LEGACY })).toMatchObject({
      regularTax: 8.25,
      total: 188.25,
    });
    expect(sumInvoiceTotals(D, { discount: 10, discountBase: LEGACY })).toMatchObject({
      regularTax: 4.13,
      total: 50.13,
    });
    expect(sumInvoiceTotals(E, { discount: 12, discountBase: LEGACY })).toMatchObject({
      regularTax: 0.83,
      total: -1.17,
    });
    expect(sumInvoiceTotals(F, { discount: 1, discountBase: LEGACY })).toMatchObject({
      regularTax: 8.25,
      total: 107.25,
    });
  });

  it("LEGACY equals the pre-W-989 arithmetic on 1,000 seeded documents (any discount, shipping, levy, exempt)", () => {
    let s = 20261114;
    const rnd = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
    for (let i = 0; i < 1000; i++) {
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => ({
        subtotal: roundMoney(rnd() * 500),
        taxRate: [0, 0.05, 0.0825, 0.08875][Math.floor(rnd() * 4)],
        categoryTaxAmount: rnd() < 0.3 ? roundMoney(rnd() * 9) : 0,
      }));
      const discount = rnd() < 0.5 ? 0 : roundMoney(rnd() * 600);
      const shipping = roundMoney(rnd() * 20);
      const exempt = rnd() < 0.2;
      const subtotal = roundMoney(lines.reduce((a, l) => a + l.subtotal, 0));
      const regularTax = exempt
        ? 0
        : roundMoney(lines.reduce((a, l) => a + l.subtotal * l.taxRate, 0));
      const categoryTax = exempt
        ? 0
        : roundMoney(lines.reduce((a, l) => a + l.categoryTaxAmount, 0));
      const tax = roundMoney(regularTax + categoryTax);
      expect(
        sumInvoiceTotals(lines, { discount, shipping, isTaxExempt: exempt, discountBase: LEGACY }),
      ).toEqual({
        subtotal,
        regularTax,
        categoryTax,
        tax,
        total: roundMoney(subtotal - discount + shipping + tax),
      });
    }
  });

  it("case 7: an omitted discountBase throws MoneyInvariantError, never a default", () => {
    // a JS caller (the compiler refuses this one)
    const call = () => sumInvoiceTotals(A, { discount: 20 } as never);
    expect(call).toThrow(MoneyInvariantError);
    expect(() => sumInvoiceTotals(A, {} as never)).toThrow(MoneyInvariantError);
    expect(() => sumInvoiceTotals(A, undefined as never)).toThrow(MoneyInvariantError);
    expect(() => sumInvoiceTotals(A, { discountBase: "pre_tax" } as never)).toThrow(
      MoneyInvariantError,
    );
  });
});

describe("computeInvoiceTotals / saleTotals carry the mode", () => {
  const line = { unitPrice: 100, qty: 1 };

  it("computeInvoiceTotals: PRE_TAX 8 / 88, LEGACY 10 / 90", () => {
    const pre = computeInvoiceTotals([line], { taxRate: 0.1, discount: 20, discountBase: PRE });
    expect([pre.tax, pre.total]).toEqual([8, 88]);
    const old = computeInvoiceTotals([line], { taxRate: 0.1, discount: 20, discountBase: LEGACY });
    expect([old.tax, old.total]).toEqual([10, 90]);
  });

  it("computeInvoiceTotals: a taxable:false line is non-taxable goods and still takes its share (7.43)", () => {
    const t = computeInvoiceTotals([line, { ...line, taxable: false }], {
      taxRate: 0.0825,
      discount: 20,
      discountBase: PRE,
    });
    expect(t.regularTax).toBe(7.43);
  });

  it("computeInvoiceTotals: omitted mode throws", () => {
    expect(() => computeInvoiceTotals([line], { taxRate: 0.1 } as never)).toThrow(
      MoneyInvariantError,
    );
  });

  it("saleTotals: PRE_TAX 8 / 88, LEGACY 10 / 90, omitted throws", () => {
    const pre = saleTotals([line], { taxRate: 0.1, discount: 20, discountBase: PRE });
    expect([pre.regularTax, pre.total]).toEqual([8, 88]);
    const old = saleTotals([line], { taxRate: 0.1, discount: 20, discountBase: LEGACY });
    expect([old.regularTax, old.total]).toEqual([10, 90]);
    expect(() => saleTotals([line], { taxRate: 0.1 } as never)).toThrow(MoneyInvariantError);
  });
});

describe("the mode of one document (R3)", () => {
  const from = new Date("2026-12-01T00:00:00.000Z");

  it("selects by the row's own createdAt against the cutover instant", () => {
    expect(discountTaxBaseOf({ createdAt: new Date("2026-11-30T23:59:59.999Z") }, from)).toBe(
      LEGACY,
    );
    expect(discountTaxBaseOf({ createdAt: from }, from)).toBe(PRE);
    expect(discountTaxBaseOf({ createdAt: new Date("2027-01-01T00:00:00Z") }, from)).toBe(PRE);
  });

  it("case 17: the dark constant is null and every row is LEGACY", () => {
    expect(DISCOUNT_PRE_TAX_FROM).toBeNull();
    expect(
      discountTaxBaseOf({ createdAt: new Date("2099-01-01T00:00:00Z") }, DISCOUNT_PRE_TAX_FROM),
    ).toBe(LEGACY);
  });

  it("the union is exactly the two modes", () => {
    expect([...DISCOUNT_TAX_BASE_VALUES]).toEqual([PRE, LEGACY]);
    expect(LEGACY_DISCOUNT_BASE).toBe(LEGACY);
  });
});

describe("rate inference divides by the mode's base (R5, case 18)", () => {
  it("taxRateBaseOf: LEGACY is the subtotal, PRE_TAX is subtotal - discount, never below 0", () => {
    expect(taxRateBaseOf(100, 20, LEGACY)).toBe(100);
    expect(taxRateBaseOf(100, 20, PRE)).toBe(80);
    expect(taxRateBaseOf(10, 12, PRE)).toBe(0);
    expect(() => taxRateBaseOf(100, 20, undefined as never)).toThrow(MoneyInvariantError);
  });

  const stored = (discount: number) => ({
    subtotal: 100,
    taxAmount: 8,
    discount,
    lines: [{ subtotal: 100, taxRate: 0, categoryTaxAmount: 0, description: "Widget" }],
  });

  it("case 18: a PRE_TAX invoice (tax 8, subtotal 100, discount 20) infers 0.10, verified (master reads 0.08)", () => {
    const r = inferredGoodsFlatRate(stored(20), { discountBase: PRE });
    expect(r).toEqual({ rate: 0.1, regularTax: 8, verified: true });
  });

  it("the same stored row read as LEGACY is today's 0.08 (byte-identical to master)", () => {
    const r = inferredGoodsFlatRate(stored(20), { discountBase: LEGACY });
    expect(r).toEqual({ rate: 0.08, regularTax: 8, verified: true });
  });

  it("a PRE_TAX base of 0 or less infers no rate", () => {
    const r = inferredGoodsFlatRate({ ...stored(100), taxAmount: 0.5 }, { discountBase: PRE });
    expect(r).toBeNull();
  });

  it("an omitted mode throws", () => {
    expect(() => inferredGoodsFlatRate(stored(20), {} as never)).toThrow(MoneyInvariantError);
  });
});

describe("the refund split stays what the invoice charged under PRE_TAX (case 12)", () => {
  it("fixture C stored under PRE_TAX: refunding each whole line returns exactly the invoice total", () => {
    const t = sumInvoiceTotals(C, { discount: 20, discountBase: PRE });
    const invoice = {
      taxAmount: t.tax,
      discount: 20,
      lines: [
        { id: "taxed", subtotal: 100, qty: 1, taxRate: 0.0825, categoryTaxAmount: 0, isNsf: false },
        { id: "free", subtotal: 100, qty: 1, taxRate: 0, categoryTaxAmount: 0, isNsf: false },
      ],
    };
    const prior = { qty: 0, net: 0, tax: 0, categoryTax: 0 };
    const a = refundableLineShare({ invoice, lineId: "taxed", returnedQty: 1, prior });
    const b = refundableLineShare({ invoice, lineId: "free", returnedQty: 1, prior });
    expect(a).toEqual({ net: 90, tax: 7.43, categoryTax: 0, total: 97.43 });
    expect(b).toEqual({ net: 90, tax: 0, categoryTax: 0, total: 90 });
    expect(roundMoney(a.total + b.total)).toBe(t.total);
  });
});
