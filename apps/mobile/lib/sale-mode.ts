import { computeInvoiceTotals, type InvoiceTotalsLine } from "./invoice-totals";
import { computeLineSubtotal, roundMoney } from "./pricing";

/**
 * Sale mode ("Delivered today?" in the invoice builder) submits through
 * `POST /orders/sell` (`useCreateSale`) instead of the plain `POST /invoices`
 * path. That path is NOT equivalent to a plain invoice: it creates an order,
 * optionally delivers it and moves stock, and issues the invoice
 * server-side with `discount: 0` hardcoded
 * (`apps/api/src/invoices/invoices.service.ts:809`) while taxing the WHOLE
 * order subtotal at the tenant rate (`apps/api/src/orders/orders.service.ts`,
 * post-PR-B `taxRateFractionFrom`) — whereas a plain mobile invoice line
 * defaults to UNTAXED (`invoiceLineDto` in `./invoice-totals` serialises
 * `taxRate: taxable ? rate : 0`, and lines are created with no `taxable`).
 *
 * `saleModeGate` decides, from the builder's own state, whether the sale
 * path would land on the EXACT same total already shown by
 * `computeInvoiceTotals`'s preview. Six enumerated rules give an
 * operator-facing reason for the common cases; a seventh — an integer-cents,
 * zero-tolerance equality check between `predictSaleInvoiceTotals` below
 * (a mirror of `orders.create` -> `createInvoiceFromOrder`) and
 * `computeInvoiceTotals` — always runs and is the real contract: it also
 * catches any divergence the six rules miss.
 *
 * Deliberately NOT gated on "tax rate is non-zero" — that workaround was
 * rejected (`.claude/pipeline/decisions/2026-08-18-batch-architecture.md`
 * §A1/§A2): the equality assertion is what keeps the gate correct even if a
 * future rate bug reappears.
 *
 * Accepted limitation (documented, not gate-detectable): the server may
 * re-price a line from a live promotion the client can't see. Both preview
 * paths shift identically and the server stays authoritative on the saved
 * total.
 */

export interface SaleGateInput {
  /** The EXACT array fed to computeInvoiceTotals — catalog + unlisted lines. */
  lines: InvoiceTotalsLine[];
  /**
   * Any unlisted line with an empty name or price <= 0. Not evaluated by the
   * 7 gate rules below (kept so this input matches the binding §A2 contract
   * shape exactly) — the caller decides what an invalid unlisted line means
   * for submission before/independent of calling this gate.
   */
  hasUnlistedInvalid: boolean;
  /** Invoice-level discount (0 if unset). */
  invDiscount: number;
  shippingFee: number;
  isTaxExempt: boolean;
  /** Tenant percent / 100 (post-PR-B server behavior). */
  taxRateFraction: number;
  /** Dirty means the operator edited the field, not a value comparison. */
  touched: { dueDate: boolean; terms: boolean; reference: boolean; subject: boolean };
  /** The builder's "Send" toggle. */
  sendNowOn: boolean;
  deliveredNow: boolean;
  /** True when any line's product.trackedCategory.invoiceTreatment === "SEPARATE_INVOICE". */
  hasSeparateInvoiceCategoryLine: boolean;
}

export type SaleGateResult = { eligible: true } | { eligible: false; reasons: string[] };

/**
 * Applies the 7 gate rules IN ORDER (§A2). Every hit appends its
 * operator-facing reason; the result is ineligible whenever any reason was
 * added. The final equality assertion (rule 7) always runs, even when an
 * earlier rule already failed, so `reasons` may list more than one cause.
 */
export function saleModeGate(input: SaleGateInput): SaleGateResult {
  const reasons: string[] = [];

  // 1. Per-line discount — OrderItemDto has no discount field, and folding
  //    it into a unitPrice override would corrupt originalPrice semantics
  //    and boxed proration.
  if (input.lines.some((line) => (line.discount ?? 0) > 0)) {
    reasons.push("a line discount is set");
  }

  // 2. Invoice-level discount — createInvoiceFromOrder hardcodes
  //    `discount: 0` server-side (invoices.service.ts:809): a set discount
  //    would silently vanish from the saved invoice.
  if (input.invDiscount > 0) {
    reasons.push("the invoice discount is set");
  }

  // 3. Tax mix — orders.create taxes the WHOLE subtotal at the tenant rate;
  //    a mobile invoice line defaults to untaxed. Equivalent only when the
  //    tenant rate is 0 (nothing to diverge on) or every line is taxed.
  const allLinesTaxed = input.lines.every((line) => (line.taxRate ?? 0) > 0);
  if (input.taxRateFraction !== 0 && !allLinesTaxed) {
    reasons.push("some lines aren't taxed");
  }

  // 4. Touched header fields — the sale path derives issueDate/dueDate
  //    itself and CreateSaleDto carries no reference/subject; anything the
  //    operator typed there would be silently dropped.
  if (
    input.touched.dueDate ||
    input.touched.terms ||
    input.touched.reference ||
    input.touched.subject
  ) {
    reasons.push("due date / terms / reference are set");
  }

  // 5. Send toggle — the server ignores dto.send entirely
  //    (orders.service.ts:1681-1685); deliveredNow=false never auto-sends,
  //    so "send now" without delivery could never be honoured.
  if (!input.deliveredNow && input.sendNowOn) {
    reasons.push("sending now without delivery");
  }

  // 6. SEPARATE_INVOICE regulated lines — the order path splits these into
  //    a sibling -R1 invoice, a different artifact than the one previewed.
  if (input.hasSeparateInvoiceCategoryLine) {
    reasons.push("a regulated item bills on its own invoice");
  }

  // 7. The real contract. Zero tolerance: both sides are roundMoney outputs,
  //    so any cents-level mismatch means the operator's preview would lie.
  const predicted = predictSaleInvoiceTotals({
    lines: input.lines,
    shippingFee: input.shippingFee,
    isTaxExempt: input.isTaxExempt,
    taxRateFraction: input.taxRateFraction,
  });
  const previewed = computeInvoiceTotals({
    lines: input.lines,
    discount: input.invDiscount,
    shippingFee: input.shippingFee,
    isTaxExempt: input.isTaxExempt,
  });
  if (Math.round(predicted.total * 100) !== Math.round(previewed.total * 100)) {
    reasons.push("the totals would not match");
  }

  return reasons.length > 0 ? { eligible: false, reasons } : { eligible: true };
}

export interface PredictSaleTotalsInput {
  lines: InvoiceTotalsLine[];
  shippingFee: number;
  isTaxExempt: boolean;
  taxRateFraction: number;
}

export interface PredictedSaleTotals {
  subtotal: number;
  taxTotal: number;
  total: number;
}

/**
 * Mirror of `orders.create` -> `createInvoiceFromOrder` for a FULL fresh
 * sale:
 *
 *   subtotal = roundMoney(Σ computeLineSubtotal(line))    [no per-line discounts on this path]
 *   tax      = isTaxExempt ? 0 : roundMoney(subtotal × taxRateFraction)
 *   total    = roundMoney(subtotal + tax + shippingFee)   [discount is hardcoded 0 server-side]
 *
 * Always routes lines through `computeLineSubtotal` — never `qty * unitPrice`
 * — so boxed proration matches the server exactly.
 */
export function predictSaleInvoiceTotals(input: PredictSaleTotalsInput): PredictedSaleTotals {
  let subtotalAccum = 0;
  for (const line of input.lines) {
    subtotalAccum += computeLineSubtotal({
      unitPrice: line.unitPrice,
      qty: line.qty,
      boxes: line.boxes ?? null,
      pieces: line.pieces ?? null,
      unitsPerBox: line.unitsPerBox ?? null,
    });
  }
  const subtotal = roundMoney(subtotalAccum);
  const taxTotal = input.isTaxExempt ? 0 : roundMoney(subtotal * input.taxRateFraction);
  const total = roundMoney(subtotal + taxTotal + input.shippingFee);
  return { subtotal, taxTotal, total };
}
