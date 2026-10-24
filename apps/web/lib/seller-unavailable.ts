import { API_ERROR_CODES } from "@routeflow/types";

/**
 * SA-733r6 (B4), buyer side: the ONE sentence a buyer sees while the seller's workspace is paused, shared by the
 * quiet line, the toast and every inline refusal. Never a word about payment, billing or plans.
 */
export function sellerUnavailableCopy(sellerName: string | null | undefined): string {
  return `${sellerName?.trim() || "This seller"} isn't taking online orders right now. Please check back soon or contact them.`;
}

/** A buyer write the API refused because the seller is paused (403 SELLER_UNAVAILABLE). */
export function isSellerUnavailableRefusal(err: unknown): boolean {
  const res = (err as { response?: { status?: number; data?: { code?: unknown } } } | null)
    ?.response;
  return res?.status === 403 && res.data?.code === API_ERROR_CODES.SELLER_UNAVAILABLE;
}
