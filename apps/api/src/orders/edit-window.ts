import { OrderStatus, UserRole } from "@prisma/client";
import type { BuyerOrderEditWindow } from "@routeflow/types";
import { holdsLiveDeliveredLine } from "./delivered-line-lock";

/**
 * B63 (REG-B63): the statuses past which a BUYER may no longer self-edit an
 * order's items. `updateOrderItems`'s write gate and the read-side `editWindow`
 * descriptor (`computeEditWindow`) both read THIS list, so a buyer client is
 * never told the window is open on an order the API is about to refuse.
 * Operators and drivers keep editing at every live stage.
 * W-1189: REFUSED (SA-1101, added after B63) is closed too: the goods came back, so a buyer's edit has nothing to change.
 */
export const BUYER_EDIT_CLOSED_STATUSES: OrderStatus[] = [
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.PARTIALLY_DELIVERED,
  OrderStatus.DELIVERED,
  OrderStatus.REFUSED,
];

/**
 * SA-1544 P-5 (REG-B63 extended): the ONE predicate of a closed BUYER window, read by the write gate
 * (`updateOrderItems`) AND by `computeEditWindow`. Closed when the order is past dispatch (the status list above) OR
 * when it HOLDS a live delivered line: a reopened order that still carries delivered goods is not a pre-dispatch order, and
 * a buyer's edit of it would restate an invoice already issued. `lines` is REQUIRED, so the compiler makes every caller
 * say what it knows.
 */
export function buyerEditClosed(
  order: { status: string },
  lines: ReadonlyArray<{ status?: unknown; deliveredQty?: unknown }> | undefined,
): boolean {
  return (
    BUYER_EDIT_CLOSED_STATUSES.includes(order.status as OrderStatus) ||
    holdsLiveDeliveredLine(lines)
  );
}

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
  role: UserRole | undefined,
  lines: ReadonlyArray<{ status?: unknown; deliveredQty?: unknown }> | undefined,
): BuyerOrderEditWindow {
  if (role === UserRole.CUSTOMER && buyerEditClosed(order, lines)) {
    // W-1189: a refused order is closed by its status, not by dispatch (no "send a change request" explanation); P-5: a
    // reopened order holding delivered goods is closed by its status too (it is not out for delivery)
    const byStatus =
      order.status === OrderStatus.REFUSED ||
      !BUYER_EDIT_CLOSED_STATUSES.includes(order.status as OrderStatus);
    return {
      editable: false,
      editableUntil: null,
      closedReason: byStatus ? "STATUS" : "DISPATCHED",
    };
  }
  const editable = order.status !== "CANCELLED";
  return {
    editable,
    editableUntil: null,
    closedReason: editable ? null : "STATUS",
  };
}
