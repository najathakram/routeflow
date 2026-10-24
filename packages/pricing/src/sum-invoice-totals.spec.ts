import { roundMoney } from "./pricing";
import { MoneyInvariantError } from "./money-invariants";
import {
  computeInvoiceTotals,
  sumInvoiceTotals,
  type InvoiceTotalsLine,
  type InvoiceTotalsOptions,
} from "./invoice-totals";

/**
 * B1043 — ONE invoice-totals formula. `sumInvoiceTotals` is the arithmetic every server writer and
 * `computeInvoiceTotals` (the client footer) share:
 *
 *   subtotal    = round(Σ s)
 *   regularTax  = exempt ? 0 : round(Σ s·r)
 *   categoryTax = exempt ? 0 : round(Σ levy)
 *   tax         = round(regularTax + categoryTax)
 *   total       = round(subtotal − d + ship + tax)
 */

/** The server's inline arithmetic, verbatim from the pre-B1043 `editInvoiceTotals` + `foldCategoryTax`. */
function legacyServer(
  items: Array<{ subtotal: number; taxRate?: number | null; categoryTaxAmount?: number }>,
  isTaxExempt: boolean,
  discount: number,
  shipping: number,
) {
  const subtotal = roundMoney(items.reduce((s, it) => s + Number(it.subtotal), 0));
  const regularTax = isTaxExempt
    ? 0
    : roundMoney(items.reduce((s, it) => s + it.subtotal * (it.taxRate ?? 0), 0));
  const categoryTax = isTaxExempt
    ? 0
    : roundMoney(items.reduce((s, it) => s + Number(it.categoryTaxAmount ?? 0), 0));
  const tax = roundMoney(regularTax + categoryTax);
  return {
    subtotal,
    regularTax,
    categoryTax,
    tax,
    total: roundMoney(subtotal - discount + shipping + tax),
  };
}

/** Deterministic LCG so the 1,000-seed property is reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("sumInvoiceTotals — the one formula", () => {
  it("sums subtotal, regular tax (one rounding over Σ s·r), levy and total", () => {
    const t = sumInvoiceTotals(
      [
        { subtotal: 1.1, taxRate: 0.05 },
        { subtotal: 1.1, taxRate: 0.05 },
      ],
      {},
    );
    expect(t).toEqual({ subtotal: 2.2, regularTax: 0.11, categoryTax: 0, tax: 0.11, total: 2.31 });
  });

  it("folds the regulated category levy into tax and total", () => {
    const t = sumInvoiceTotals([{ subtotal: 100, taxRate: 0.08, categoryTaxAmount: 5 }], {
      shipping: 10,
    });
    expect(t).toEqual({ subtotal: 100, regularTax: 8, categoryTax: 5, tax: 13, total: 123 });
  });

  it("an exempt customer owes $0 of BOTH taxes", () => {
    const t = sumInvoiceTotals([{ subtotal: 100, taxRate: 0.08, categoryTaxAmount: 5 }], {
      isTaxExempt: true,
    });
    expect(t.regularTax).toBe(0);
    expect(t.categoryTax).toBe(0);
    expect(t.tax).toBe(0);
    expect(t.total).toBe(100);
  });

  it("applies the discount and shipping after tax is computed on the line subtotals", () => {
    const t = sumInvoiceTotals([{ subtotal: 50, taxRate: 0.1 }], { discount: 2, shipping: 1 });
    expect(t.tax).toBe(5);
    expect(t.total).toBe(54);
  });

  it("each line carries its own rate (mixed taxable / non-taxable)", () => {
    const t = sumInvoiceTotals(
      [{ subtotal: 100, taxRate: 0.08 }, { subtotal: 100, taxRate: 0 }, { subtotal: 100 }],
      {},
    );
    expect(t.regularTax).toBe(8);
    expect(t.total).toBe(308);
  });

  it("reads a stored row as it comes: numeric strings and Decimal-like values coerce with Number", () => {
    const dec = (v: string) => ({ toString: () => v });
    const t = sumInvoiceTotals(
      [{ subtotal: dec("10.00"), taxRate: dec("0.1000"), categoryTaxAmount: "1.5" }],
      {},
    );
    expect(t).toEqual({ subtotal: 10, regularTax: 1, categoryTax: 1.5, tax: 2.5, total: 12.5 });
  });

  it("is pure: never mutates its input lines", () => {
    const lines = [{ subtotal: 10, taxRate: 0.1, categoryTaxAmount: 1 }];
    const before = JSON.stringify(lines);
    sumInvoiceTotals(lines, { isTaxExempt: true });
    expect(JSON.stringify(lines)).toBe(before);
  });

  it("empty lines and non-finite inputs are zeros", () => {
    expect(sumInvoiceTotals([], {})).toEqual({
      subtotal: 0,
      regularTax: 0,
      categoryTax: 0,
      tax: 0,
      total: 0,
    });
    expect(sumInvoiceTotals([{ subtotal: Number.NaN }], { discount: Number.NaN }).total).toBe(0);
  });

  it("property (1,000 seeds): equals the inline server arithmetic, rates to 6 dp, levies, exempt, discount, shipping", () => {
    const rand = rng(1043);
    for (let n = 0; n < 1000; n++) {
      const count = Math.floor(rand() * 6);
      const lines = Array.from({ length: count }, () => ({
        subtotal: roundMoney((rand() - 0.1) * 500),
        taxRate: Math.round(rand() * 0.2 * 1e6) / 1e6,
        categoryTaxAmount: rand() < 0.4 ? roundMoney(rand() * 12) : 0,
      }));
      const exempt = rand() < 0.3;
      const discount = roundMoney(rand() * 40);
      const shipping = roundMoney(rand() * 25);
      const got = sumInvoiceTotals(lines, { discount, shipping, isTaxExempt: exempt });
      expect(got).toEqual(legacyServer(lines, exempt, discount, shipping));
    }
  });
});

describe("computeInvoiceTotals composes sumInvoiceTotals", () => {
  it("without the new inputs it is identical to the old arithmetic over varied fixtures", () => {
    const rand = rng(7);
    for (let n = 0; n < 300; n++) {
      const lines: InvoiceTotalsLine[] = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => ({
        unitPrice: roundMoney(rand() * 30),
        qty: 1 + Math.floor(rand() * 5),
        discount: rand() < 0.3 ? roundMoney(rand() * 3) : 0,
        taxable: rand() < 0.2 ? false : undefined,
        taxRate: rand() < 0.3 ? Math.round(rand() * 0.1 * 1e4) / 1e4 : undefined,
      }));
      const opts: InvoiceTotalsOptions = {
        taxRate: Math.round(rand() * 0.1 * 1e4) / 1e4,
        discount: roundMoney(rand() * 5),
        shipping: roundMoney(rand() * 5),
      };
      const got = computeInvoiceTotals(lines, opts);
      // old formula, inlined
      const lineTotals = got.lineTotals;
      const subtotal = roundMoney(lineTotals.reduce((s, x) => s + x, 0));
      const tax = roundMoney(
        lines.reduce((s, l, i) => {
          const r =
            l.taxRate != null ? Number(l.taxRate) : l.taxable === false ? 0 : Number(opts.taxRate);
          return s + lineTotals[i] * r;
        }, 0),
      );
      expect(got.subtotal).toBe(subtotal);
      expect(got.tax).toBe(tax);
      expect(got.total).toBe(
        roundMoney(subtotal - Number(opts.discount) + Number(opts.shipping) + tax),
      );
      expect(got.regularTax).toBe(tax);
      expect(got.categoryTax).toBe(0);
    }
  });

  it("a levy line (categoryTaxAmount 5) adds 5.00 to tax and total", () => {
    const t = computeInvoiceTotals([{ unitPrice: 100, qty: 1, categoryTaxAmount: 5 }], {
      taxRate: 0.08,
    });
    expect(t.categoryTax).toBe(5);
    expect(t.regularTax).toBe(8);
    expect(t.tax).toBe(13);
    expect(t.total).toBe(113);
  });

  it("isTaxExempt zeroes the regular tax AND the levy (rate 0.08)", () => {
    const t = computeInvoiceTotals([{ unitPrice: 100, qty: 1, categoryTaxAmount: 5 }], {
      taxRate: 0.08,
      isTaxExempt: true,
    });
    expect(t.tax).toBe(0);
    expect(t.regularTax).toBe(0);
    expect(t.categoryTax).toBe(0);
    expect(t.total).toBe(100);
  });
});

describe("sumInvoiceTotals strict mode (N4) - the server refuses non-finite money, the display default does not", () => {
  it("default (non-strict) keeps treating a non-finite value as 0, unchanged for web and mobile", () => {
    expect(
      sumInvoiceTotals([{ subtotal: Number.NaN, taxRate: 0.1 }], { discount: Number.NaN }).total,
    ).toBe(0);
    expect(
      computeInvoiceTotals([{ unitPrice: Number.NaN, qty: 3 }], { taxRate: Number.NaN }).total,
    ).toBe(0);
  });

  it.each([
    ["a line subtotal", [{ subtotal: Number.NaN }], {}],
    ["a line rate", [{ subtotal: 1, taxRate: Number.POSITIVE_INFINITY }], {}],
    ["a line levy", [{ subtotal: 1, categoryTaxAmount: "abc" }], {}],
    ["the discount", [{ subtotal: 1 }], { discount: Number.NaN }],
    ["the shipping", [{ subtotal: 1 }], { shipping: Number.NaN }],
  ])("strict throws MoneyInvariantError for %s", (_n, lines, opts) => {
    expect(() => sumInvoiceTotals(lines as any, { ...opts, strict: true })).toThrow(
      MoneyInvariantError,
    );
  });

  it("strict still reads null / undefined as an absent amount (0), not as an error", () => {
    expect(
      sumInvoiceTotals([{ subtotal: 5, taxRate: null, categoryTaxAmount: undefined }], {
        discount: null,
        strict: true,
      }).total,
    ).toBe(5);
  });

  it("strict gives identical results to non-strict on finite input (1,000 seeds)", () => {
    const rand = rng(99);
    for (let n = 0; n < 1000; n++) {
      const lines = Array.from({ length: Math.floor(rand() * 5) }, () => ({
        subtotal: roundMoney(rand() * 300),
        taxRate: Math.round(rand() * 0.15 * 1e6) / 1e6,
        categoryTaxAmount: roundMoney(rand() * 9),
      }));
      const o = {
        discount: roundMoney(rand() * 20),
        shipping: roundMoney(rand() * 9),
        isTaxExempt: rand() < 0.3,
      };
      expect(sumInvoiceTotals(lines, { ...o, strict: true })).toEqual(sumInvoiceTotals(lines, o));
    }
  });
});
