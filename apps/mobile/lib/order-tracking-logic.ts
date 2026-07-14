/**
 * Pure helpers for the buyer order-tracking card + Reorder action (P10-BUY-8).
 * No network, no price math — Reorder carries qty/box/piece counts forward
 * UNCHANGED; the server (POST /buyer/orders) re-prices and re-runs every
 * guard fresh, same as any other buyer order create.
 */
import type { BuyerOrder } from "./api/buyer";

export interface ReorderItem {
  productId: string;
  qty: number;
  boxes?: number;
  pieces?: number;
}

/** Non-cancelled, catalog-backed (productId present), positive-qty lines
 *  only. Operator-added "unlisted" lines (no productId) can exist on an
 *  order but can never be reordered through the buyer create path. */
export function buildReorderItems(order: Pick<BuyerOrder, "lineItems">): ReorderItem[] {
  return order.lineItems
    .filter((li) => li.status !== "CANCELLED" && !!li.productId && Number(li.qty) > 0)
    .map((li) => ({
      productId: li.productId,
      qty: Number(li.qty),
      ...(li.boxes != null ? { boxes: li.boxes } : {}),
      ...(li.pieces != null ? { pieces: li.pieces } : {}),
    }));
}

/** Reorder only makes sense once an order has actually been placed — DRAFT/
 *  PENDING orders are still directly editable (see the existing Edit-items
 *  action), so Reorder is hidden there to avoid two competing affordances. */
export function canReorder(order: Pick<BuyerOrder, "status">): boolean {
  return order.status !== "DRAFT" && order.status !== "PENDING";
}

/** Timeline step index for the 5-step bar (mirrors web's buyer-order-detail
 *  STATUS_STEPS). -1 for any status not in the happy path (e.g. CANCELLED —
 *  callers hide the whole tracking section for CANCELLED instead). */
const STATUS_STEPS = [
  "PENDING",
  "CONFIRMED",
  "OUT_FOR_DELIVERY",
  "PARTIALLY_DELIVERED",
  "DELIVERED",
];
export function trackingStepIndex(status: string): number {
  return STATUS_STEPS.indexOf(status);
}
