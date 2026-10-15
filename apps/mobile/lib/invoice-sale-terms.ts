import { isPaidAtSale } from "@routeflow/pricing";
import type { PaidAtSaleInvoice } from "@routeflow/pricing";

/**
 * Row 401 / CQ-26: a counter sale paid at the till is settled when it is rung, so its invoice shows no due date and no
 * payment terms (display only; the stored values are untouched). The server answers once with `paidAtSale` on the invoice
 * detail (the buyer copy carries no order or payment instants); a staff payload from a server without the flag is judged
 * by the SAME shared rule. Unclear = the terms keep showing.
 */
export function invoiceShowsTerms(
  inv: (PaidAtSaleInvoice & { paidAtSale?: boolean | null }) | null | undefined,
): boolean {
  if (!inv) return true;
  return !(typeof inv.paidAtSale === "boolean" ? inv.paidAtSale : isPaidAtSale(inv));
}
