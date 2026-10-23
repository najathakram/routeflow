import type { OrdersMoreMenuItem } from "../../_components/OrdersMoreMenu";

/**
 * The actions that step out of the order-detail bar into its "More actions" menu at phone width
 * (apple-ux r4 Q19), so the bar is ONE row: Edit, the primary (full width), More.
 *
 * Every condition below mirrors the one on the button it replaces (same status, same access flag,
 * same refusal), and every item runs the SAME handler: Cancel Order still opens its confirm, Delete
 * still opens its inline "Delete order?" confirm, Unconfirm / Return to Confirmed still ask for a
 * reason. Nothing here decides anything the page did not already decide.
 */
export interface PhoneActionContext {
  status: string;
  isEditing: boolean;
  staff: boolean;
  canCancel: boolean;
  /** Server verdict: the parcel is with the carrier (no Cancel, no Delete). */
  cancelBlocked: boolean;
  /** The page's own gate for Delete on an open, un-invoiced order. */
  canDeleteOpen: boolean;
  isShip: boolean;
  returnAvailable: boolean;
  onRecordReturn: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onUnconfirm: () => void;
  onReturnToConfirmed: () => void;
}

/**
 * A menu entry that opens a dialog runs a tick later: while the menu is still closing, its focus trap and
 * the new dialog's fight over focus (an endless focus ping-pong in jsdom, a flicker in a browser).
 */
const afterMenuCloses = (fn: () => void) => () => {
  setTimeout(fn, 0);
};

export function phoneActionItems(c: PhoneActionContext): OrdersMoreMenuItem[] {
  const items: OrdersMoreMenuItem[] = [];
  const open = !c.isEditing;

  if (open && c.staff && c.returnAvailable) {
    items.push({ label: "Record return", onSelect: afterMenuCloses(c.onRecordReturn) });
  }
  if (c.staff && c.status === "CONFIRMED" && open) {
    items.push({ label: "Unconfirm", onSelect: afterMenuCloses(c.onUnconfirm) });
  }
  if (c.staff && c.status === "OUT_FOR_DELIVERY") {
    items.push({
      label: c.isShip ? "Unmark shipped" : "Return to Confirmed",
      onSelect: afterMenuCloses(c.onReturnToConfirmed),
    });
  }

  const cancel =
    !c.cancelBlocked &&
    ((c.status === "DRAFT" && open && !c.staff && c.canCancel) ||
      (c.status === "PENDING" && open && c.canCancel) ||
      (c.status === "CONFIRMED" && open && c.staff) ||
      (c.status === "OUT_FOR_DELIVERY" && c.staff));
  if (cancel)
    items.push({ label: "Cancel Order", onSelect: afterMenuCloses(c.onCancel), danger: true });

  const del =
    (c.status === "DRAFT" && open && c.staff) ||
    (c.status === "PENDING" && open && c.staff && !c.cancelBlocked) ||
    (c.status === "CONFIRMED" && open && c.staff && !c.cancelBlocked && c.canDeleteOpen) ||
    (c.status === "OUT_FOR_DELIVERY" && c.staff && !c.cancelBlocked && c.canDeleteOpen) ||
    (c.status === "CANCELLED" && c.staff);
  if (del) {
    items.push({
      label: c.status === "DRAFT" ? "Delete Draft" : "Delete order",
      onSelect: afterMenuCloses(c.onDelete),
      danger: true,
    });
  }
  return items;
}
