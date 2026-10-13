import { useQuery } from "@tanstack/react-query";
import type { BuyerSellerCapability } from "@routeflow/types";
import { buyerApiClient } from "../buyer-auth";
import { useBuyerSessionStore } from "../buyer-session-store";
import { isSellerAccepting } from "../seller-unavailable";

/** Query-key prefix for the active seller's buyer-safe capability facts (`GET /buyer/capabilities`). */
export const BUYER_CAPABILITIES_KEY = ["buyer", "capabilities"] as const;

/**
 * The active SELLER's buyer-safe facts from `GET /buyer/capabilities` (the one source web's
 * `useBuyerSellerCapabilities` reads). Seller-scoped, so the key carries the seller slug and it never fires without
 * an active seller. Kept out of `./buyer` so suites that mock that module stay untouched.
 */
export function useBuyerSellerCapabilities() {
  const sellerSlug = useBuyerSessionStore((s) => s.activeSeller?.tenant.slug) ?? null;
  return useQuery<BuyerSellerCapability>({
    queryKey: [...BUYER_CAPABILITIES_KEY, sellerSlug],
    queryFn: () => buyerApiClient.get("/buyer/capabilities").then((r) => r.data),
    staleTime: 5 * 60 * 1000,
    enabled: !!sellerSlug,
  });
}

/** False only when the API says the seller is paused; loading, error and a missing field never block a buyer. */
export function useSellerAcceptingOrders(): boolean {
  const { data } = useBuyerSellerCapabilities();
  return isSellerAccepting(data);
}
