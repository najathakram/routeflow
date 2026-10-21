import type { ToastData } from "@routeflow/ui/web";
import { markOrderCreatedHere } from "@/lib/order-created-echo";

export interface OrderCreatedToastInput {
  /** The operator's answer to the merge prompt ("merge" folds the lines into an open order). */
  mergeChoice?: string | null;
  /** True for "Save as draft". */
  asDraft?: boolean | null;
  /** The API response — only `id` / `orderNumber` are read; the merge case returns the merged order. */
  created?: { id?: string | null; orderNumber?: string | null } | null;
  /** Navigates to an order. Optional: with no handler the toast has no action (the old behaviour). */
  onViewOrder?: (orderId: string) => void;
}

/**
 * The success toast for CreateOrderModal. The modal closes on success and the operator used to
 * have no path from the confirmation to the order (order-ui-redesign-spec.md §8): a forced
 * redirect would fight rapid multi-order entry, so this offers a one-click "View Order" action
 * on the toast instead of navigating on its own.
 */
/** F28: with an action the toast stays until dismissed (the X), so a glance away never loses "View Order". */
const ACTION_TOAST_MS = 24 * 60 * 60 * 1000;

export function orderCreatedToast({
  mergeChoice,
  asDraft,
  created,
  onViewOrder,
}: OrderCreatedToastInput): Omit<ToastData, "id"> {
  // F17: record this tab's own order so the realtime echo does not toast it a second time.
  markOrderCreatedHere(created?.orderNumber);
  const merged = mergeChoice === "merge";
  const orderId = created?.id ?? null;
  const action =
    orderId && onViewOrder
      ? {
          label: merged ? "View Merged Order" : "View Order",
          onClick: () => onViewOrder(orderId),
        }
      : undefined;

  if (merged) {
    return {
      title: `Merged into order ${created?.orderNumber ?? "#" + created?.id?.slice(0, 6)}`,
      variant: "success",
      action,
      ...(action ? { duration: ACTION_TOAST_MS } : {}),
    };
  }
  return {
    title: asDraft ? "Order saved as draft" : "Order created",
    variant: "success",
    action,
    ...(action ? { duration: ACTION_TOAST_MS } : {}),
  };
}
