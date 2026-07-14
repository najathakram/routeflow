/**
 * Pure helpers for the buyer "Your Sellers" directory (P10-BUY-1). Status
 * classification + action-eligibility only — no network, no math.
 * buyer.service.ts getSellers() only ever returns ACTIVE / INVITED /
 * PENDING_SELLER_APPROVAL links (SUSPENDED/DISCONNECTED are filtered out
 * server-side), so those are the only statuses this needs to classify; the
 * default branch below is a defensive fallback, not a reachable case today.
 */
import type { BuyerSeller } from "./buyer-auth";

export type SellerPillVariant = "green" | "orange" | "yellow" | "gray";

export function sellerStatusPill(status: string): { variant: SellerPillVariant; label: string } {
  switch (status) {
    case "ACTIVE":
      return { variant: "green", label: "Active" };
    case "PENDING_SELLER_APPROVAL":
      return { variant: "orange", label: "Pending approval" };
    case "INVITED":
      return { variant: "yellow", label: "Invited" };
    default:
      return { variant: "gray", label: status };
  }
}

/** Only an ACTIVE link can be switched into. */
export function canOpenSeller(seller: Pick<BuyerSeller, "linkStatus">): boolean {
  return seller.linkStatus === "ACTIVE";
}

/** PENDING/INVITED links show "Cancel request" (DELETE /buyer/sellers/:slug —
 *  the same disconnect endpoint, used pre-activation to withdraw a request). */
export function canCancelRequest(seller: Pick<BuyerSeller, "linkStatus">): boolean {
  return seller.linkStatus === "PENDING_SELLER_APPROVAL" || seller.linkStatus === "INVITED";
}
