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
 * It is NOT the server's stored total. The server also (1) adds the regulated CATEGORY tax to the
 * invoice tax and (2) zeroes all tax for a tax-exempt customer; this estimate models neither, so a
 * footer can differ from the saved invoice for such lines or customers.
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
}

export interface InvoiceTotalsOptions {
  /** Invoice-level money discount. Default 0. */
  discount?: number | null;
  /** Shipping / delivery fee. Default 0. */
  shipping?: number | null;
  /** Invoice-level tax rate as a fraction, applied to every line that is not `taxable: false`. */
  taxRate?: number | null;
}

export interface InvoiceTotals {
  /** Each line's post-discount, boxed-aware, rounded total. Same order as input. */
  lineTotals: number[];
  subtotal: number;
  tax: number;
  discount: number;
  shipping: number;
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

export function computeInvoiceTotals(
  lines: readonly InvoiceTotalsLine[],
  opts: InvoiceTotalsOptions = {},
): InvoiceTotals {
  const lineTotals = lines.map(computeInvoiceLineTotal);
  const subtotal = roundMoney(lineTotals.reduce((s, t) => s + t, 0));
  const defaultRate = finite(opts.taxRate);
  const tax = roundMoney(
    lines.reduce((s, line, i) => {
      const rate =
        line.taxRate != null ? finite(line.taxRate) : line.taxable === false ? 0 : defaultRate;
      return s + lineTotals[i] * rate;
    }, 0),
  );
  const discount = finite(opts.discount);
  const shipping = finite(opts.shipping);
  const total = roundMoney(subtotal - discount + shipping + tax);
  return { lineTotals, subtotal, tax, discount, shipping, total };
}
