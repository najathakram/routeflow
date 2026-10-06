import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/** What a stored counter sale is, judged from its order status and its invoices' statuses (ALL of them, voided included). */
export type StoredSaleState = "live" | "incomplete" | "voided";

/**
 * The ONE rule for "is this stored sale still a sale?" (SA-672c), shared by createSale's replay and GET .../by-key:
 *  - an order that is not PENDING or DELIVERED (CANCELLED, or anything else that moved on) is VOIDED;
 *  - invoices exist but every one is VOID / WRITTEN_OFF: VOIDED (nothing live to finish or charge);
 *  - a PENDING/DELIVERED order with NO invoice rows at all: INCOMPLETE (the first attempt stopped early, so a
 *    re-POST with the same key finishes it);
 *  - otherwise live.
 * A re-POST of a VOIDED sale must never invoice, send, charge or write a status again.
 */
export function storedSaleState(
  orderStatus: string,
  invoiceStatuses: readonly string[],
): StoredSaleState {
  if (orderStatus !== "PENDING" && orderStatus !== "DELIVERED") return "voided";
  if (invoiceStatuses.length === 0) return "incomplete";
  return invoiceStatuses.every((s) => s === "VOID" || s === "WRITTEN_OFF") ? "voided" : "live";
}

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
