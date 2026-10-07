import { API_ERROR_CODES } from "@routeflow/types";

/**
 * The create-order idempotency refusals that mean "this submit already made an order": the key
 * already belongs to an order (with a different cart, or as a draft). The body may carry that
 * order's `orderId`; the buyer-facing copy below is fixed and never the server's message.
 * (The server scrubs `orderId` when the key is held by another customer's order.)
 */
const CONFLICT_CODES: ReadonlySet<string> = new Set([
  "IDEMPOTENCY_KEY_CONFLICT",
  API_ERROR_CODES.IDEMPOTENCY_KEY_CART_MISMATCH,
  API_ERROR_CODES.IDEMPOTENCY_KEY_DRAFT_MISMATCH,
]);

export const BUYER_ORDER_CONFLICT_COPY = "Your order was already placed — open it";
export const BUYER_ORDER_CONFLICT_NO_ID_COPY =
  "Your order may already be placed. Check your orders.";

/** `{ orderId? }` when `err` is one of those refusals, otherwise `null`. */
export function buyerOrderConflict(err: unknown): { orderId?: string } | null {
  const res = (
    err as { response?: { status?: number; data?: { code?: unknown; orderId?: unknown } } } | null
  )?.response;
  if (res?.status !== 409 || typeof res.data?.code !== "string") return null;
  if (!CONFLICT_CODES.has(res.data.code)) return null;
  const id = res.data.orderId;
  return typeof id === "string" && id ? { orderId: id } : {};
}
