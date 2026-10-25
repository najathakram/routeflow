import { toCents } from "./cents";
import { allocateCentsLargestRemainder } from "./largest-remainder";
import { MoneyInvariantError } from "./money-invariants";
import { creditedThrough, roundMoney } from "./pricing";

/**
 * SA-840 (B704 / #1477): THE price of a return or refund of a SLICE of an invoice line, as what the invoice CHARGED:
 * the line's net (less its share of the invoice discount), its share of the regular tax and its share of the category tax
 * (levy). Pure; reads the invoice AS STORED (`taxAmount`, `discount`, every line's `subtotal` / `taxRate` /
 * `categoryTaxAmount`), never the live customer, a live rate or a profile key. `computeLineSubtotal` is never re-run: a
 * boxed line's stored subtotal IS its output, so `qty x unitPrice` (which over-charges by `unitsPerBox`) never appears.
 *
 * Every rounding goes through `roundMoney` / `creditedThrough` / `allocateCentsLargestRemainder` / `toCents`.
 */

/** A stored money column: a number, a numeric string, or a Decimal (anything `Number()` reads). */
export type StoredMoney = number | string | { toString(): string };

/** One invoice line as stored. `isNsf` comes from the shared `isNsfLine` predicate; an NSF fee line is never goods. */
export interface RefundableInvoiceLine {
  id: string;
  subtotal: StoredMoney;
  qty: StoredMoney;
  taxRate?: StoredMoney | null;
  categoryTaxAmount?: StoredMoney | null;
  isNsf: boolean;
}

/** The credited invoice as stored. `taxAmount` and `discount` are REQUIRED: a missing pool throws, never reads as 0. */
export interface RefundableInvoice {
  taxAmount: StoredMoney;
  discount: StoredMoney;
  /** every line, in row order (`createdAt`, `id`) */
  lines: readonly RefundableInvoiceLine[];
}

/** What is already credited on the line (qty on the line's own axis). */
export interface RefundPrior {
  qty: number;
  net: number;
  tax: number;
  categoryTax: number;
}

/** The refund of a slice, whole cents. `total = net + tax + categoryTax`; `net` is after the line's discount share. */
export interface RefundBreakdown {
  net: number;
  tax: number;
  categoryTax: number;
  total: number;
}

export interface RefundableLineShare extends RefundBreakdown {
  /** The slice is not refundable at all: the caller refuses (409), the helper never clips. */
  refusal?: "QTY_OVER_LINE" | "LINE_NOT_ON_INVOICE";
}

export interface RefundableLineShareInput {
  invoice: RefundableInvoice;
  lineId: string;
  /** qty returned on THIS line's own axis (the caller converts pieces through `piecesPerQtyOf`) */
  returnedQty: number;
  prior: RefundPrior;
}

const ZERO: RefundBreakdown = { net: 0, tax: 0, categoryTax: 0, total: 0 };

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function finite(label: string, value: unknown): number {
  const n = value == null || value === "" ? NaN : Number(value);
  if (!Number.isFinite(n)) {
    throw new MoneyInvariantError(
      `Refund share: ${label} must be a finite number (got ${String(value)}).`,
    );
  }
  return n;
}

/**
 * A `Decimal(9,6)` tax-rate FRACTION as integer micro-units (0.08 -> 80000), read through a 4-dp snap like `round4`, so
 * 0.07 x 1e6 is 70000 and never 70000.00000000001. A missing rate is 0; a non-finite one throws.
 */
export function taxRateMicros(rate: StoredMoney | null | undefined): number {
  if (rate == null) return 0;
  const n = finite("tax rate", rate);
  return Math.round(Number((Math.abs(n) * 1_000_000).toFixed(4)));
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** Largest-remainder split of `total` by `weights`, with the weights reduced by their gcd (keeps `cents x weight` exact). */
function split(total: number, weights: number[]): number[] {
  const g = weights.reduce((acc, w) => gcd(acc, w), 0);
  return allocateCentsLargestRemainder(total, g > 1 ? weights.map((w) => w / g) : weights);
}

export function refundableLineShare(input: RefundableLineShareInput): RefundableLineShare {
  const { invoice, lineId, returnedQty, prior } = input;
  const invoiceTax = roundMoney(finite("invoice tax", invoice.taxAmount));
  const discount = roundMoney(finite("invoice discount", invoice.discount));
  if (!invoice.lines.some((l) => l.id === lineId)) {
    return { ...ZERO, refusal: "LINE_NOT_ON_INVOICE" };
  }
  const goods = invoice.lines.filter((l) => !l.isNsf);
  const at = goods.findIndex((l) => l.id === lineId);
  if (at < 0) return { ...ZERO }; // the NSF fee line: never credited

  // 1. Invoice pools: what was charged (an exempt invoice stores tax 0, so both pools are 0 whatever rate a line kept)
  const subtotals = goods.map((l) => Math.max(0, finite("line subtotal", l.subtotal)));
  const levies = goods.map((l) =>
    Math.max(0, finite("line category tax", l.categoryTaxAmount ?? 0)),
  );
  const categoryPool = Math.min(roundMoney(levies.reduce((a, n) => a + n, 0)), invoiceTax);
  const regularPool = roundMoney(invoiceTax - categoryPool);

  // 2. Per-line charges, largest remainder over the goods lines (Σ == the pool exactly)
  const cents = subtotals.map((s) => toCents(s));
  const rateWeights = goods.map((l, i) => cents[i] * taxRateMicros(l.taxRate));
  const taxShares = split(regularPool, rateWeights.some((w) => w > 0) ? rateWeights : cents);
  const levyShares = split(
    categoryPool,
    levies.map((c) => toCents(c)),
  );
  const discountShares = split(discount, cents);

  // 3. Slice, telescoped: any chunking of a line sums to the component exactly
  const line = goods[at];
  const lineQty = finite("line qty", line.qty);
  const priorQty = Math.max(0, Number(prior.qty) || 0);
  const qty = Math.max(0, Number(returnedQty) || 0);
  if (qty > 0 && round3(priorQty + qty) > round3(lineQty))
    return { ...ZERO, refusal: "QTY_OVER_LINE" };

  // 4. Cap: each component is clamped to its own room (never a clip of the qty)
  const slice = (component: number, credited: number): number =>
    Math.min(
      roundMoney(
        creditedThrough(component, priorQty + qty, lineQty) -
          creditedThrough(component, priorQty, lineQty),
      ),
      Math.max(0, roundMoney(component - credited)),
    );
  const net = slice(Math.max(0, roundMoney(subtotals[at] - discountShares[at])), prior.net);
  const tax = slice(taxShares[at], prior.tax);
  const categoryTax = slice(levyShares[at], prior.categoryTax);
  return { net, tax, categoryTax, total: roundMoney(net + tax + categoryTax) };
}
