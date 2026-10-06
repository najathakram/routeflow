"use client";

import { useQuery } from "@tanstack/react-query";
import type { BuyerSellerCapability } from "@routeflow/types";
import { buyerApiClient } from "@/lib/buyer-api-client";
import { getStoredActiveSeller } from "@/lib/buyer-auth";

/**
 * Business profiles 1B: the active SELLER's buyer-safe fulfilment facts — exactly
 * { portalMethods, portalDefault, fleet } — from `GET /buyer/capabilities` (the staff
 * `/tenants/me/features` needs a staff JWT and carries staff fields). Seller-scoped,
 * so the key carries the seller slug and it never fires without an active seller (A5, as
 * `useBuyerShelf`). Kept out of `./buyer` so suites that mock that module stay untouched.
 */
export function useBuyerSellerCapabilities() {
  const sellerSlug = getStoredActiveSeller()?.tenant.slug ?? null;
  return useQuery<BuyerSellerCapability>({
    queryKey: ["buyer", "capabilities", sellerSlug],
    queryFn: () => buyerApiClient.get("/buyer/capabilities").then((r) => r.data),
    staleTime: 5 * 60 * 1000,
    enabled: !!sellerSlug,
  });
}
