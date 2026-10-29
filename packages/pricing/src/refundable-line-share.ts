import { toCents } from "./cents";
import { allocateCentsLargestRemainder } from "./largest-remainder";
import { MoneyInvariantError } from "./money-invariants";
import { isNsfLine } from "./nsf-line";
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

/** What the invoice charged on each goods line in full: net after the line's discount share, tax, category tax. */
interface LineCharge {
  net: number;
  tax: number;
  categoryTax: number;
}

/** The invoice pools allocated onto its goods lines (largest remainder, Σ == the pool exactly). Throws on a bad pool. */
function chargesOf(invoice: RefundableInvoice): {
  goods: RefundableInvoiceLine[];
  charges: LineCharge[];
} {
  const invoiceTax = roundMoney(finite("invoice tax", invoice.taxAmount));
  const discount = roundMoney(finite("invoice discount", invoice.discount));
  const goods = invoice.lines.filter((l) => !l.isNsf);

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
  return {
    goods,
    charges: goods.map((_, i) => ({
      net: Math.max(0, roundMoney(subtotals[i] - discountShares[i])),
      tax: taxShares[i],
      categoryTax: levyShares[i],
    })),
  };
}

/** One component of a slice: telescoped over the prior credited qty, capped at what the component has left. */
function sliceOf(
  component: number,
  priorQty: number,
  qty: number,
  totalQty: number,
  credited: number,
): number {
  return Math.min(
    roundMoney(
      creditedThrough(component, priorQty + qty, totalQty) -
        creditedThrough(component, priorQty, totalQty),
    ),
    Math.max(0, roundMoney(component - credited)),
  );
}

export function refundableLineShare(input: RefundableLineShareInput): RefundableLineShare {
  const { invoice, lineId, returnedQty, prior } = input;
  const { goods, charges } = chargesOf(invoice);
  if (!invoice.lines.some((l) => l.id === lineId)) {
    return { ...ZERO, refusal: "LINE_NOT_ON_INVOICE" };
  }
  const at = goods.findIndex((l) => l.id === lineId);
  if (at < 0) return { ...ZERO }; // the NSF fee line: never credited

  // 3. Slice, telescoped: any chunking of a line sums to the component exactly
  const lineQty = finite("line qty", goods[at].qty);
  const priorQty = Math.max(0, Number(prior.qty) || 0);
  const qty = Math.max(0, Number(returnedQty) || 0);
  if (qty > 0 && round3(priorQty + qty) > round3(lineQty))
    return { ...ZERO, refusal: "QTY_OVER_LINE" };

  // 4. Cap: each component is clamped to its own room (never a clip of the qty)
  const c = charges[at];
  const net = sliceOf(c.net, priorQty, qty, lineQty, prior.net);
  const tax = sliceOf(c.tax, priorQty, qty, lineQty, prior.tax);
  const categoryTax = sliceOf(c.categoryTax, priorQty, qty, lineQty, prior.categoryTax);
  return { net, tax, categoryTax, total: roundMoney(net + tax + categoryTax) };
}

/** One of a product's lines on the invoice, in SPREAD order (paid lines first, $0 lines last). */
export interface ProductPoolLine {
  id: string;
  /** the line's qty in PIECES (qty x piecesPerQty) */
  pieces: number;
  /** already credited on this line: pieces, and the net / tax / category tax amounts */
  prior: RefundPrior;
}

export interface ProductPoolShareInput {
  invoice: RefundableInvoice;
  lines: readonly ProductPoolLine[];
  /** pieces returned from the pool, an item that names only the product */
  returnedPieces: number;
}

export interface ProductPoolShare extends RefundableLineShare {
  /** the slice spread over `lines` (same order): each no more than its line's room, Σ == the slice exactly */
  spread: Array<RefundBreakdown & { id: string }>;
}

/**
 * SA-970 (amends SA-840 §2): a return item that names only the PRODUCT is sliced over the product's POOL on that invoice,
 * one virtual line: each component X (net, tax, category tax) pools as Σ of SA-840's per-line charges, over Σ pieces,
 * telescoped on the pooled prior credit. The slice is then spread over `lines` in order (paid first), each line taking no
 * more than its own room for that component, so Σ spread == slice. One line in the pool is exactly `refundableLineShare`.
 * A qty past the pool's pieces is a refusal, never a clip.
 */
export function refundableProductPoolShare(input: ProductPoolShareInput): ProductPoolShare {
  const { invoice, lines, returnedPieces } = input;
  const { goods, charges } = chargesOf(invoice);
  const empty = lines.map((l) => ({ id: l.id, ...ZERO }));
  const idx = lines.map((l) => invoice.lines.findIndex((x) => x.id === l.id));
  if (idx.some((i) => i < 0)) return { ...ZERO, refusal: "LINE_NOT_ON_INVOICE", spread: empty };

  const charge = lines.map((l) => {
    const g = goods.findIndex((x) => x.id === l.id);
    return g < 0 ? { net: 0, tax: 0, categoryTax: 0 } : charges[g]; // an NSF fee line carries no goods charge
  });
  const sum = (f: (i: number) => number) => lines.reduce((t, _, i) => t + f(i), 0);
  const pool = {
    pieces: sum((i) => Math.max(0, finite("line pieces", lines[i].pieces))),
    priorPieces: sum((i) => Math.max(0, Number(lines[i].prior.qty) || 0)),
  };
  const qty = Math.max(0, Number(returnedPieces) || 0);
  if (qty > 0 && round3(pool.priorPieces + qty) > round3(pool.pieces))
    return { ...ZERO, refusal: "QTY_OVER_LINE", spread: empty };

  const spread = lines.map((l) => ({ id: l.id, ...ZERO }));
  const total = { net: 0, tax: 0, categoryTax: 0 };
  for (const k of ["net", "tax", "categoryTax"] as const) {
    const poolCharge = roundMoney(sum((i) => charge[i][k]));
    const priorAmt = roundMoney(sum((i) => Number(lines[i].prior[k]) || 0));
    const room = lines.map((l, i) => Math.max(0, roundMoney(charge[i][k] - (l.prior[k] || 0))));
    let rest = Math.min(
      sliceOf(poolCharge, pool.priorPieces, qty, pool.pieces, priorAmt),
      roundMoney(room.reduce((t, r) => t + r, 0)),
    );
    total[k] = rest;
    room.forEach((r, i) => {
      const take = Math.min(rest, r);
      spread[i][k] = take;
      rest = roundMoney(rest - take);
    });
  }
  spread.forEach((s) => (s.total = roundMoney(s.net + s.tax + s.categoryTax)));
  return { ...total, total: roundMoney(total.net + total.tax + total.categoryTax), spread };
}

/** One stored invoice item as the refund helper reads it (a Prisma row, a Decimal column or a spec fixture). */
export interface StoredInvoiceItem {
  id?: string | null;
  subtotal: StoredMoney;
  qty: StoredMoney;
  taxRate?: StoredMoney | null;
  categoryTaxAmount?: StoredMoney | null;
  systemKind?: string | null;
  description?: string | null;
}

/** A stored invoice with its items. */
export interface StoredInvoice {
  taxAmount: StoredMoney;
  discount: StoredMoney;
  items?: readonly StoredInvoiceItem[] | null;
}

/**
 * The invoice as `refundableLineShare` reads it: stored rows only, the NSF fee line flagged by the shared `isNsfLine`
 * predicate. `lineIds` overrides the item ids (a fixture / legacy item with no id gets a positional one). The mapping lives
 * here, next to the helper that consumes it, so no API site restates a line's stored tax columns.
 */
export function refundableInvoiceOf(
  invoice: StoredInvoice,
  lineIds?: readonly string[],
): RefundableInvoice {
  return {
    taxAmount: invoice.taxAmount,
    discount: invoice.discount,
    lines: (invoice.items ?? []).map((it, i) => ({
      id: lineIds?.[i] ?? it.id ?? "",
      subtotal: it.subtotal,
      qty: it.qty,
      taxRate: it.taxRate,
      categoryTaxAmount: it.categoryTaxAmount,
      isNsf: isNsfLine(it),
    })),
  };
}
