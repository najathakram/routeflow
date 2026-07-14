/**
 * Detects the server's credit-limit block (409 CREDIT_LIMIT_EXCEEDED, thrown by
 * apps/api/src/orders/orders.service.ts#assertWithinCreditLimit) on the order-edit
 * (updateOrderItems) and at-door change-request-resolve (approveChangeRequestAtStop)
 * paths. Pure — no api-client import — unit-testable without RN. Mirrors the shape
 * of lib/authorizations-logic.ts#parseRegulatedAuthError.
 *
 * IMPORTANT: the server has NO bypass/override for this block anywhere (grepped
 * orders.service.ts, update-order-items.dto.ts, change-requests.service.ts — no
 * "creditOverride" field exists, no "flags account" field on Customer). Unlike the
 * regulated-license guard, there is no legal "sell anyway" exit — only "collect a
 * payment to reduce exposure" or "cancel this change." Do not add a client-side
 * override button; there is nothing server-side for it to call.
 */
export interface CreditLimitExceededInfo {
  /** The customer's configured credit_limit (server, Customer.creditLimit). */
  limit: number;
  /** What the customer's AR exposure would become if this change were saved. */
  exposure: number;
  /** Server's own sentence — render verbatim, never reconstruct from limit/exposure. */
  message: string;
}

export function parseCreditLimitError(err: unknown): CreditLimitExceededInfo | null {
  const res = (
    err as {
      response?: {
        status?: number;
        data?: { code?: string; limit?: number; exposure?: number; message?: string };
      };
    }
  )?.response;
  if (res?.status !== 409 || res.data?.code !== "CREDIT_LIMIT_EXCEEDED") return null;
  return {
    limit: Number(res.data.limit ?? 0),
    exposure: Number(res.data.exposure ?? 0),
    message: res.data.message ?? "This would exceed the customer's credit limit.",
  };
}
