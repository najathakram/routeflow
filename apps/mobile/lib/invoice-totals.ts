import { computeLineSubtotal, roundMoney } from "@routeflow/pricing";
import type { CreateInvoiceItem } from "./api/invoices";

/**
 * Client-side mirror of the SERVER's invoice money formula
 * (apps/api/src/invoices/invoices.service.ts:202-287, same math on the PATCH
 * items path at :2258-2320):
 *
 *   lineSub  = roundMoney(computeLineSubtotal(line) − line.discount)
 *   subtotal = roundMoney(Σ lineSub)
 *   tax      = isTaxExempt ? 0 : roundMoney(Σ lineSub × line.taxRate)
 *   total    = roundMoney(subtotal − invoiceDiscount + shippingFee + tax)
 *
 * Deliberate consequences to preserve:
 *  - per-line discount comes off BEFORE tax (tax is charged on the discounted line);
 *  - the invoice-level discount comes off AFTER tax (it never shrinks the tax base);
 *  - shippingFee is a flat post-tax addend — never taxed, never in subtotal;
 *  - customer.isTaxExempt zeroes ALL tax (web's create preview gets this wrong —
 *    it shows tax the saved invoice won't have; we match the server instead);
 *  - rounding happens per line and once per aggregate, exactly like the server
 *    (web's create preview skips the per-line rounding; its edit preview doesn't).
 *
 * Known preview gap (shared with web): regulated products additionally get
 * per-category tax server-side (foldCategoryTax) from tracked-category rates
 * the client can't see, so the preview may under-show for those lines.
 */

export interface InvoiceTotalsLine {
  unitPrice: number;
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  /** Flat dollars off this line (not a percent). */
  discount?: number;
  /** Tax FRACTION for this line (0.08 = 8%), applied to the post-discount subtotal. */
  taxRate?: number;
  /** BUY_N_GET_M: whole free selling units, subtracted BEFORE pricing (exact —
   *  never a rounded net unit price). 0/absent for every other line. */
  freeUnits?: number;
}

export interface InvoiceTotals {
  subtotal: number;
  taxTotal: number;
  discount: number;
  shippingFee: number;
  total: number;
  /** Any line whose discount exceeds its subtotal — the server rejects these. */
  hasNegativeLine: boolean;
}

export function computeInvoiceTotals(input: {
  lines: InvoiceTotalsLine[];
  discount?: number;
  shippingFee?: number;
  isTaxExempt?: boolean;
}): InvoiceTotals {
  const discount = input.discount ?? 0;
  const shippingFee = input.shippingFee ?? 0;
  let subtotal = 0;
  let taxAccum = 0;
  let hasNegativeLine = false;
  for (const line of input.lines) {
    const before = computeLineSubtotal({
      unitPrice: line.unitPrice,
      qty: line.qty,
      boxes: line.boxes ?? null,
      pieces: line.pieces ?? null,
      unitsPerBox: line.unitsPerBox ?? null,
      freeUnits: line.freeUnits ?? 0,
    });
    const lineSub = roundMoney(before - (line.discount ?? 0));
    if (lineSub < 0) hasNegativeLine = true;
    subtotal += lineSub;
    // Tax on the POST-discount line subtotal (RF-079) — sum first, round once.
    taxAccum += lineSub * (line.taxRate ?? 0);
  }
  subtotal = roundMoney(subtotal);
  const taxTotal = input.isTaxExempt ? 0 : roundMoney(taxAccum);
  const total = roundMoney(subtotal - discount + shippingFee + taxTotal);
  return { subtotal, taxTotal, discount, shippingFee, total, hasNegativeLine };
}

/**
 * BUY_N_GET_M free units for a line the operator is EDITING, rescaled to the
 * quantity now on screen. Mirrors web's invoice edit page (and the order engine's
 * `rescaleBogoFreeUnits` fallback): the snapshot was earned at `baseUnits` whole
 * selling units, so a shrunk line earns proportionally fewer and a grown one never
 * earns MORE than was already agreed. Capped at units − 1 — the buyer always pays
 * the N in every (N + M), so no edit can make a line entirely free. Loose pieces
 * never count: a boxed line's units are its BOXES.
 */
export function editedLineFreeUnits(line: {
  promoFreeUnits?: number | null;
  /** Whole selling units the snapshot was earned at (defaults to the line's own). */
  promoBaseUnits?: number | null;
  boxes?: number | null;
  qty: number;
}): number {
  const stored = Math.max(0, Math.trunc(Number(line.promoFreeUnits ?? 0) || 0));
  if (stored <= 0) return 0;
  const units = Math.trunc(Number(line.boxes != null ? line.boxes : line.qty) || 0);
  if (units <= 0) return 0;
  const base = Math.max(0, Math.trunc(Number(line.promoBaseUnits ?? units) || 0));
  const earned = base > 0 ? Math.floor((stored * units) / base) : stored;
  return Math.min(stored, earned, units - 1);
}

// ─── DTO serialisation ────────────────────────────────────────────────────────

export interface BuilderInvoiceLine {
  description: string;
  productId?: string | null;
  qty: number;
  unitPrice: number;
  boxes?: number | null;
  pieces?: number | null;
  /** unitsPerBox gates whether a boxes/pieces split is sent at all (web rule). */
  unitsPerBox?: number | null;
  discount?: number;
  /** UI toggle; serialised as `taxRate: taxable ? rate : 0` exactly like web
   *  (apps/web/app/(dashboard)/invoices/new/page.tsx:992). */
  taxable?: boolean;
  notes?: string;
  /** BUY_N_GET_M snapshot carried from the order line — see InvoiceTotalsLine. */
  promoFreeUnits?: number;
}

/**
 * One builder line → the POST/PATCH /invoices item shape. The API's global
 * ValidationPipe runs whitelist+forbidNonWhitelisted, so ONLY CreateInvoiceItemDto
 * fields may appear (`taxable`/`unitsPerBox` must never leak onto the wire).
 *
 * `taxRateFraction` is the tenant rate as a FRACTION (settings.taxRate / 100).
 */
export function invoiceLineDto(
  line: BuilderInvoiceLine,
  taxRateFraction: number,
): CreateInvoiceItem {
  const upb = Number(line.unitsPerBox ?? 0);
  const notes = line.notes?.trim();
  return {
    description: line.description,
    ...(line.productId ? { productId: line.productId } : {}),
    qty: line.qty,
    unitPrice: line.unitPrice,
    // Split only travels for a boxed catalog line — the server only honours
    // boxes/pieces when productId is set AND the product has unitsPerBox.
    ...(line.productId && upb > 1 && line.boxes != null ? { boxes: line.boxes } : {}),
    ...(line.productId && upb > 1 && line.pieces != null ? { pieces: line.pieces } : {}),
    ...(line.discount && line.discount > 0 ? { discount: line.discount } : {}),
    // MONEY: the PATCH path replaces every line, so the BOGO snapshot must travel
    // or an agreed 12-boxes-2-free line re-prices from $350 to $420 on save.
    ...(line.promoFreeUnits && line.promoFreeUnits > 0
      ? { promoFreeUnits: Math.trunc(line.promoFreeUnits) }
      : {}),
    taxRate: line.taxable ? taxRateFraction : 0,
    ...(notes ? { notes } : {}),
  };
}
