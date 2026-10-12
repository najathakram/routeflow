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
