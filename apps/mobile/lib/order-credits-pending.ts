import { API_ERROR_CODES } from "@routeflow/types";

/** B1205: same fixed sentence as web's CREDITS_PENDING_COPY. The server's own text is never shown. */
export const CREDITS_PENDING_COPY =
  "The order was saved, but the credit notes weren't applied. Apply them on the order.";

export interface SavedCreditsPending {
  kind: "saved-credits-pending";
  orderId: string;
  message: string;
}

const saved = (orderId: string): SavedCreditsPending => ({
  kind: "saved-credits-pending",
  orderId,
  message: CREDITS_PENDING_COPY,
});

/**
 * B1205: 503 ORDER_SAVED_CREDITS_PENDING carries the saved order's id. The order EXISTS, so it is
 * opened (credits are applied there) and never resubmitted. Any other error returns null.
 */
export function creditsPendingFromError(err: unknown): SavedCreditsPending | null {
  const r = (err as { response?: { status?: number; data?: { code?: string; orderId?: string } } })
    ?.response;
  if (r?.status !== 503 || r.data?.code !== API_ERROR_CODES.ORDER_SAVED_CREDITS_PENDING)
    return null;
  return r.data.orderId ? saved(String(r.data.orderId)) : null;
}

/** B1205: read-only `creditsPending` hint on a keyed replay's (successful) response. */
export function creditsPendingFromOrder(
  order: { id?: string; creditsPending?: boolean } | null | undefined,
): SavedCreditsPending | null {
  return order?.creditsPending && order.id ? saved(order.id) : null;
}
