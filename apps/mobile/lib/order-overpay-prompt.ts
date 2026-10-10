import { confirm } from "./confirm";
import { showToast } from "./toast";
import {
  ORDER_OVERPAY_TITLE,
  orderOverpayCopy,
  orderOverpayReturnRoute,
  parseOrderEditWouldOverpay,
} from "./order-overpay-error";

/**
 * P-4: handles a `409 ORDER_EDIT_WOULD_OVERPAY` on the edit-items save. Returns true when the error was this refusal and the user
 * was told (fixed copy; with the inline-returns add-on, "Record a return" opens the order's inline-return screen); false so the caller keeps its own handling.
 * Lives here, not in the screen, because edit-items.tsx is pinned by size-ratchet.spec.ts.
 */
export function handleOrderOverpay(
  err: unknown,
  order: { id: string; customerId?: string; customerName?: string; canRecordReturn?: boolean },
  router: { push: (route: never) => void },
): boolean {
  const info = parseOrderEditWouldOverpay(err);
  if (!info) return false;
  const copy = orderOverpayCopy(info, order.canRecordReturn === true);
  // The inline-return screen is add-on gated (every /returns/inline/* route 403s without it): no add-on, no exit.
  const route = order.canRecordReturn === true ? orderOverpayReturnRoute(order) : null;
  if (!route) showToast(copy);
  else
    confirm(ORDER_OVERPAY_TITLE, copy, () => router.push(route as never), {
      confirmText: "Record a return",
    });
  return true;
}
