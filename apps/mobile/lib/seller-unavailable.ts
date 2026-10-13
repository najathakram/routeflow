import { API_ERROR_CODES } from "@routeflow/types";
import type { BuyerSellerCapability } from "@routeflow/types";

/**
 * SA-733r6 (B4), buyer side. While the seller's workspace is read-only the buyer sees ONE quiet line and Place Order
 * is disabled with the same reason. Nothing in grace, and never a word about payment, billing or plans: the API sends
 * one boolean (`acceptingOrders`) and no reason. Mirrors web's `SellerUnavailableLine` copy byte for byte.
 */
export function sellerUnavailableCopy(sellerName: string | null | undefined): string {
  return `${sellerName?.trim() || "This seller"} isn't taking online orders right now. Please check back soon or contact them.`;
}

/** False only when the API says the seller is paused; unknown (loading, error, absent field) never blocks. */
export function isSellerAccepting(
  cap: Pick<BuyerSellerCapability, "acceptingOrders"> | null | undefined,
): boolean {
  return cap?.acceptingOrders !== false;
}

/**
 * The buyer-facing copy for an order-submit refusal that means "this seller is paused" (403 SELLER_UNAVAILABLE), or
 * `null` for any other error so the caller's own handling runs. Fixed copy, never the server's message.
 */
export function submitErrorCopy(
  err: unknown,
  sellerName: string | null | undefined,
): string | null {
  const res = (err as { response?: { status?: number; data?: { code?: unknown } } } | null)
    ?.response;
  if (res?.status !== 403 || res.data?.code !== API_ERROR_CODES.SELLER_UNAVAILABLE) return null;
  return sellerUnavailableCopy(sellerName);
}
