/**
 * CQ-26 / row 401: a counter sale paid at the till is settled the moment it is rung, so its invoice shows no payment
 * terms and no due date ("Net 30 / Due 31 Oct" on a cash sale reads as money still owed). Display only: the stored terms
 * and due date are untouched, and a counter sale put on account (or one paid later) keeps showing them.
 *
 * ONE predicate for every surface that prints an invoice (web detail, PDF, e-mail, mobile). It lives in this compiled
 * package because the API cannot value-import `@routeflow/types` (source-only). Pure: no React, no DOM, no network; timestamps may be ISO strings (JSON payloads) or Dates (Prisma rows).
 */

/** How close to the invoice's creation a payment must be recorded to count as "paid at the sale" (one request, one sale). */
export const AT_SALE_WINDOW_MS = 10 * 60 * 1000;

/** The payment-terms labels the product writes (`getDaysForTerms` in web/mobile `invoice-terms` returns days for exactly these). */
const PAYMENT_TERMS_LABELS: ReadonlyArray<string> = [
  "Due on Receipt",
  "Net 15",
  "Net 30",
  "Net 45",
  "Net 60",
];

type Instant = string | Date | null | undefined;

export interface PaidAtSaleInvoice {
  status?: string | null;
  createdAt?: Instant;
  order?: { counterSale?: boolean | null } | null;
  payments?: ReadonlyArray<{ createdAt?: Instant; status?: string | null }> | null;
}

function instantMs(value: Instant): number {
  if (value instanceof Date) return value.getTime();
  return typeof value === "string" ? Date.parse(value) : NaN;
}

/**
 * True only for a counter-sale invoice that is PAID and whose every payment row was written within minutes of the invoice
 * itself (the till's one request). Anything unclear (no payments in the payload, a missing timestamp, a later payment, a
 * credit applied afterwards) is false, so the terms keep showing.
 */
export function isPaidAtSale(inv: PaidAtSaleInvoice | null | undefined): boolean {
  if (!inv || inv.order?.counterSale !== true || inv.status !== "PAID") return false;
  const created = instantMs(inv.createdAt);
  // a VOID row is no payment (a duplicate recorded later and voided must not flip the answer between surfaces)
  const payments = (inv.payments ?? []).filter((p) => p.status !== "VOID");
  if (!Number.isFinite(created) || payments.length === 0) return false;
  return payments.every((p) => {
    const at = instantMs(p.createdAt);
    return Number.isFinite(at) && Math.abs(at - created) <= AT_SALE_WINDOW_MS;
  });
}

/** True when `text` is only a payment-terms label (the invoice's own label, or one of the product's closed list). */
export function isPaymentTermsText(text: string, label?: string | null): boolean {
  const raw = text.trim();
  return raw === (label ?? "").trim() || PAYMENT_TERMS_LABELS.includes(raw);
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
  return isPaymentTermsText(raw, inv?.paymentTermsLabel) ? null : raw;
}
