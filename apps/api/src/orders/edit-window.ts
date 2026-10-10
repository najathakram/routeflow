import { OrderStatus, UserRole } from "@prisma/client";
import type { BuyerOrderEditWindow } from "@routeflow/types";

/**
 * B63 (REG-B63): the statuses past which a BUYER may no longer self-edit an
 * order's items. `updateOrderItems`'s write gate and the read-side `editWindow`
 * descriptor (`computeEditWindow`) both read THIS list, so a buyer client is
 * never told the window is open on an order the API is about to refuse.
 * Operators and drivers keep editing at every live stage.
 */
export const BUYER_EDIT_CLOSED_STATUSES: OrderStatus[] = [
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.PARTIALLY_DELIVERED,
  OrderStatus.DELIVERED,
];

/**
 * P5-08 / R1: derive the non-persisted edit-window descriptor from an order.
 * editable ⟺ the order isn't CANCELLED — items can now be edited at every live
 * stage (incl. OUT_FOR_DELIVERY / DELIVERED, on dispatched runs), with the write
 * gate re-syncing any linked invoice + ledger. Single source of truth shared by
 * the read and the write gate. `dispatched` no longer closes the window.
 *
 * B63 (REG-B63): for a CUSTOMER the window DOES close once the order is out the
 * door — the same `BUYER_EDIT_CLOSED_STATUSES` the write gate refuses on, so the
 * descriptor never reports "nothing is wrong" while `updateOrderItems` answers
 * 403. `closedReason: "DISPATCHED"` is what buyer clients read to explain it.
 */
export function computeEditWindow(
  order: {
    status: string;
    routeRunId?: string | null;
    routeRun?: { status: string } | null;
  },
  role?: UserRole,
): BuyerOrderEditWindow {
  if (
    role === UserRole.CUSTOMER &&
    BUYER_EDIT_CLOSED_STATUSES.includes(order.status as OrderStatus)
  ) {
    return { editable: false, editableUntil: null, closedReason: "DISPATCHED" };
  }
  const editable = order.status !== "CANCELLED";
  return {
    editable,
    editableUntil: null,
    closedReason: editable ? null : "STATUS",
  };
}
