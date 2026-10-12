import { getDaysForTerms } from "./invoice-terms";

/**
 * CQ-26: a counter sale paid at the till is settled the moment it is rung, so its invoice shows no payment terms and no due
 * date ("Net 30 / Due 31 Oct" on a cash sale reads as money still owed). Display only: the stored terms and due date are
 * untouched, and a counter sale put on account (or one paid later) keeps showing them.
 */

/** How close to the invoice's creation a payment must be recorded to count as "paid at the sale" (one request, one sale). */
const AT_SALE_WINDOW_MS = 10 * 60 * 1000;

export interface PaidAtSaleInvoice {
  status?: string | null;
  createdAt?: string | null;
  order?: { counterSale?: boolean | null } | null;
  payments?: ReadonlyArray<{ createdAt?: string | null }> | null;
}

/**
 * True only for a counter-sale invoice that is PAID and whose every payment row was written within minutes of the invoice
 * itself (the till's one request). Anything unclear (no payments in the payload, a missing timestamp, a later payment, a
 * credit applied afterwards) is false, so the terms keep showing.
 */
export function isPaidAtSale(inv: PaidAtSaleInvoice | null | undefined): boolean {
  if (!inv || inv.order?.counterSale !== true || inv.status !== "PAID") return false;
  const created = Date.parse(inv.createdAt ?? "");
  const payments = inv.payments ?? [];
  if (!Number.isFinite(created) || payments.length === 0) return false;
  return payments.every((p) => {
    const at = Date.parse(p.createdAt ?? "");
    return Number.isFinite(at) && Math.abs(at - created) <= AT_SALE_WINDOW_MS;
  });
}

/**
 * The "Terms & Conditions" text the invoice should print, or null for none. The stored `terms` falls back to the payment
 * terms label ("Net 30") when the business has no long-form T&C, so a cash sale paid at the till printed "Terms & Conditions:
 * Net 30" even with the Terms and Due rows hidden. For a paid-at-sale invoice (the SAME predicate as those rows) a text that
 * is only the payment terms is dropped; a real long-form T&C text stays, and every other invoice is untouched.
 */
export function termsAndConditionsToShow(
  inv:
    (PaidAtSaleInvoice & { terms?: unknown; paymentTermsLabel?: string | null }) | null | undefined,
): string | null {
  const raw = typeof inv?.terms === "string" ? inv.terms.trim() : "";
  if (!raw) return null;
  if (!isPaidAtSale(inv)) return raw;
  const label = inv?.paymentTermsLabel?.trim();
  const onlyPaymentTerms = raw === label || getDaysForTerms(raw) !== null;
  return onlyPaymentTerms ? null : raw;
}
