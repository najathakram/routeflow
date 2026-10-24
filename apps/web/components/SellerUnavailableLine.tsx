"use client";

import * as React from "react";
import { useBuyerSellerCapabilities } from "@/lib/api/buyer-capabilities";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import { sellerUnavailableCopy } from "@/lib/seller-unavailable";

/**
 * SA-733r6 (B4), buyer side: while the seller's workspace is read-only the buyer sees ONE quiet line above the
 * product grid and Checkout is disabled with the same reason. Nothing in grace (the buyer is told nothing until
 * the seller is actually paused), and never a word about payment, billing or plans: the API sends one boolean
 * (`acceptingOrders`) and no reason.
 */
export { sellerUnavailableCopy };

/** False only when the API says the seller is paused; unknown (loading, error) never blocks a buyer. */
export function useSellerAcceptingOrders(): boolean {
  const { data } = useBuyerSellerCapabilities();
  return data?.acceptingOrders !== false;
}

export function SellerUnavailableLine({ className }: { className?: string }) {
  const accepting = useSellerAcceptingOrders();
  const { activeSeller } = useBuyerAuth();
  if (accepting) return null;
  return (
    <p
      role="status"
      data-testid="seller-unavailable-line"
      id="seller-unavailable-line"
      className={className ?? "mb-4 rounded-lg bg-surface-raised px-4 py-3 text-sm text-navy/80"}
    >
      {sellerUnavailableCopy(activeSeller?.tenant.name)}
    </p>
  );
}
