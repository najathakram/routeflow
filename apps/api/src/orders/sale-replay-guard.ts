import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/** What a stored counter sale is, judged from its order status and its invoices' statuses (ALL of them, voided included). */
export type StoredSaleState = "live" | "incomplete" | "voided" | "changed";

/**
 * The ONE rule for "is this stored sale still a sale?" (SA-672c/d), used by GET .../by-key (all four answers) and by
 * createSale's replay guard (which separates a moved order BEFORE asking, see assertSaleReplayable):
 *  - voided: the order is CANCELLED, or there is at least one invoice and EVERY one is VOID / WRITTEN_OFF;
 *  - incomplete: a PENDING or DELIVERED order with NO invoice rows at all, OR whose live invoice is still a DRAFT
 *    (createSale sends every invoice before the tender, so a DRAFT means the send step never finished, or the office
 *    pulled the invoice back to draft). A re-POST with the same key finishes it; by-key must say so, never "done";
 *  - changed: an order in any OTHER status (CONFIRMED, OUT_FOR_DELIVERY, PARTIALLY_DELIVERED, ...) with NO invoice
 *    rows: staff moved it on and nothing can be read back;
 *  - live: anything else, which includes a PAID sale that staff moved to CONFIRMED or PARTIALLY_DELIVERED (a live
 *    invoice exists), so the clerk never rings it again and charges the customer twice.
 * A re-POST of a VOIDED sale must never invoice, send, charge or write a status again.
 */
export function storedSaleState(
  orderStatus: string,
  invoiceStatuses: readonly string[],
): StoredSaleState {
  if (orderStatus === "CANCELLED") return "voided";
  if (invoiceStatuses.length === 0) {
    return orderStatus === "PENDING" || orderStatus === "DELIVERED" ? "incomplete" : "changed";
  }
  if (invoiceStatuses.every((s) => s === "VOID" || s === "WRITTEN_OFF")) return "voided";
  // Row 383: a half sale (order + DRAFT invoice, send failed) is not a finished sale. Only a PENDING / DELIVERED order
  // is judged this way: an order staff moved on stays "live" (never rung twice).
  if (
    (orderStatus === "PENDING" || orderStatus === "DELIVERED") &&
    invoiceStatuses.some((s) => s === "DRAFT")
  ) {
    return "incomplete";
  }
  return "live";
}

export const saleChangedConflict = () =>
  new ConflictException({
    code: API_ERROR_CODES.COUNTER_SALE_CHANGED,
    message: "This sale was changed after it was rung — check with the office.",
  });

export const saleVoidedConflict = () =>
  new ConflictException({
    code: API_ERROR_CODES.COUNTER_SALE_VOIDED,
    message: "This sale was voided after it was rung — start a new sale.",
  });

/**
 * createSale's replay guard, run BEFORE anything is re-written. A replayed order that was CANCELLED, or whose
 * invoices are all VOID / WRITTEN_OFF, is VOIDED (definitive: start a new sale). Any OTHER status than PENDING,
 * DELIVERED or CANCELLED (CONFIRMED, OUT_FOR_DELIVERY, PARTIALLY_DELIVERED, ...) stays the unknown-outcome
 * COUNTER_SALE_ORDER_CHANGED: the sale exists and the till cannot tell what became of it.
 */
export async function assertSaleReplayable(
  db: { invoice: { findMany(args: any): Promise<Array<{ status: string }>> } },
  order: { id: string; status: string },
): Promise<void> {
  if (order.status === "CANCELLED") throw saleVoidedConflict();
  if (order.status !== "PENDING" && order.status !== "DELIVERED") {
    throw new ConflictException({
      code: API_ERROR_CODES.COUNTER_SALE_ORDER_CHANGED,
      message: "This sale's order was changed after it was created",
    });
  }
  const rows = await db.invoice.findMany({
    where: { orderId: order.id },
    select: { status: true },
  });
  if (
    storedSaleState(
      order.status,
      rows.map((r) => r.status),
    ) === "voided"
  )
    throw saleVoidedConflict();
}
