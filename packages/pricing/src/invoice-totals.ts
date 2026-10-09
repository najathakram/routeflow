import { computeLineSubtotal, roundMoney, type LineSubtotalInput } from "./pricing";

/**
 * Invoice / estimate footer ESTIMATE — the ONE place a builder form sums its lines for the
 * line / tax / total footer it shows before save.
 *
 * It uses the server's rounding arithmetic (`invoices.service.ts` create/update): every line is its
 * own boxed-aware, post-discount, `roundMoney`-ed total; the subtotal is `roundMoney(sum of lines)`;
 * the tax is summed UNROUNDED across lines and rounded ONCE (`roundMoney(Σ line × rate)`), never
 * per line; and `total = roundMoney(subtotal − discount + shipping + tax)`. A form that sums raw
 * floats instead shows 0.30000000000000004-class drift (L-170: round before the value drives
 * anything).
 *
 * B1043: the arithmetic below `computeInvoiceLineTotal` is `sumInvoiceTotals`, the ONE formula the
 * server's invoice writers (create, edit, duplicate, estimate convert, the header-only PATCH) share
 * with this footer. It models the regulated CATEGORY tax (`line.categoryTaxAmount`) and a
 * tax-exempt customer (`opts.isTaxExempt`: $0 of BOTH taxes) when the caller passes them. A form that
 * omits those inputs still gets the plain regular-tax estimate, so a footer can differ from the saved
 * invoice for a levy line or an exempt customer the form did not tell it about.
 *
 * Pure and framework-free: web builder/edit forms and the estimate footer import it, never
 * re-deriving `qty * unitPrice` (over-charges a boxed line by `unitsPerBox`).
 */
export interface InvoiceTotalsLine extends LineSubtotalInput {
  /** Per-line money discount, taken off the line's boxed-aware subtotal. Default 0. */
  discount?: number | null;
  /** `false` exempts the line from the invoice-level `taxRate`. Default: taxed. */
  taxable?: boolean | null;
  /** This line's own tax rate as a fraction (0.08 = 8%). Wins over the invoice-level `taxRate`. */
  taxRate?: number | null;
  /** This line's regulated CATEGORY (levy) tax in money. Folded into `tax` unless exempt. Default 0. */
  categoryTaxAmount?: number | null;
}

export interface InvoiceTotalsOptions {
  /** Invoice-level money discount. Default 0. */
  discount?: number | null;
  /** Shipping / delivery fee. Default 0. */
  shipping?: number | null;
  /** Invoice-level tax rate as a fraction, applied to every line that is not `taxable: false`. */
  taxRate?: number | null;
  /** Tax-exempt customer: $0 of BOTH the regular tax and the category tax. Default false. */
  isTaxExempt?: boolean | null;
}

export interface InvoiceTotals {
  /** Each line's post-discount, boxed-aware, rounded total. Same order as input. */
  lineTotals: number[];
  subtotal: number;
  /** `roundMoney(regularTax + categoryTax)` - what the invoice stores as its tax. */
  tax: number;
  /** The sales-tax part: `exempt ? 0 : roundMoney(sum of line x rate)`. */
  regularTax: number;
  /** The regulated category (levy) part: `exempt ? 0 : roundMoney(sum of levy)`. */
  categoryTax: number;
  discount: number;
  shipping: number;
  total: number;
}

/** One already-priced line as `sumInvoiceTotals` reads it: its stored (post-discount) subtotal, rate and levy. */
export interface SummedInvoiceLine {
  subtotal: number;
  /** This line's tax rate as a fraction. Default 0. */
  taxRate?: number | null;
  /** This line's regulated category tax in money. Default 0. */
  categoryTaxAmount?: number | null;
}

export interface SumInvoiceTotalsOptions {
  discount?: number | null;
  shipping?: number | null;
  isTaxExempt?: boolean | null;
}

export interface SummedInvoiceTotals {
  subtotal: number;
  regularTax: number;
  categoryTax: number;
  tax: number;
  total: number;
}

const finite = (n: number | null | undefined): number => {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? v : 0;
};

/**
 * One line's post-discount total: `computeLineSubtotal` (boxes/pieces/free units), then discount.
 * NOT floored at 0: the server stores exactly `roundMoney(before - discount)` and refuses a negative
 * line (`Line item ... has a negative subtotal`), so a footer that floored would show a total the
 * server never computes. Forms refuse a line discount above its line before submit instead.
 */
export function computeInvoiceLineTotal(line: InvoiceTotalsLine): number {
  const before = computeLineSubtotal({
    unitPrice: finite(line.unitPrice),
    qty: finite(line.qty),
    boxes: line.boxes ?? null,
    pieces: line.pieces ?? null,
    unitsPerBox: line.unitsPerBox ?? null,
    freeUnits: line.freeUnits ?? 0,
  });
  return roundMoney(before - finite(line.discount));
}

/**
 * B1043: THE invoice-totals formula, over lines whose subtotals are already priced (stored rows, or
 * `computeInvoiceLineTotal` outputs). Every writer and the client footer call this; none re-derives it.
 *
 *   subtotal    = round(sum s)
 *   regularTax  = exempt ? 0 : round(sum s*r)      (summed UNROUNDED across lines, rounded ONCE)
 *   categoryTax = exempt ? 0 : round(sum levy)
 *   tax         = round(regularTax + categoryTax)
 *   total       = round(subtotal - discount + shipping + tax)
 *
 * Pure: never mutates `lines`. Each line carries its own `taxRate` (mixed rates). Sums run in row order.
 */
export function sumInvoiceTotals(
  lines: readonly SummedInvoiceLine[],
  opts: SumInvoiceTotalsOptions = {},
): SummedInvoiceTotals {
  const exempt = opts.isTaxExempt === true;
  const subtotal = roundMoney(lines.reduce((s, l) => s + finite(l.subtotal), 0));
  const regularTax = exempt
    ? 0
    : roundMoney(lines.reduce((s, l) => s + finite(l.subtotal) * finite(l.taxRate), 0));
  const categoryTax = exempt
    ? 0
    : roundMoney(lines.reduce((s, l) => s + finite(l.categoryTaxAmount), 0));
  const tax = roundMoney(regularTax + categoryTax);
  const total = roundMoney(subtotal - finite(opts.discount) + finite(opts.shipping) + tax);
  return { subtotal, regularTax, categoryTax, tax, total };
}

export function computeInvoiceTotals(
  lines: readonly InvoiceTotalsLine[],
  opts: InvoiceTotalsOptions = {},
): InvoiceTotals {
  const lineTotals = lines.map(computeInvoiceLineTotal);
  const defaultRate = finite(opts.taxRate);
  const summed = sumInvoiceTotals(
    lines.map((line, i) => ({
      subtotal: lineTotals[i],
      taxRate:
        line.taxRate != null ? finite(line.taxRate) : line.taxable === false ? 0 : defaultRate,
      categoryTaxAmount: line.categoryTaxAmount,
    })),
    { discount: opts.discount, shipping: opts.shipping, isTaxExempt: opts.isTaxExempt },
  );
  return {
    lineTotals,
    subtotal: summed.subtotal,
    tax: summed.tax,
    regularTax: summed.regularTax,
    categoryTax: summed.categoryTax,
    discount: finite(opts.discount),
    shipping: finite(opts.shipping),
    total: summed.total,
  };
}
