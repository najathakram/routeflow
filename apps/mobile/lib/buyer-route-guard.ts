/**
 * Buyer route guard — the one decision both the root layout and the
 * (customer) layout apply. Pure, so it is Jest-pinned
 * (__tests__/buyer-route-guard.test.ts).
 *
 * #2341 (owner "guard go", 2026-09-27): a signed-in buyer with 0 sellers — a
 * fresh in-app sign-up, or a login whose account has no seller yet — may reach
 * ONLY the seller picker and connect screens, mirroring web's /buyer/portal.
 * Every other (customer) route still requires an active seller.
 */

export const SELLERLESS_LANDING = "/(customer)/sellers/connect";
const CUSTOMER_LOGIN = "/(auth)/customer-login";
const CUSTOMER_HOME = "/(customer)/(tabs)/home";

/** The routes a buyer with no active seller may stay on: sellers, sellers/connect. */
export function isSellerlessRoute(segments: string[]): boolean {
  if (segments[0] !== "(customer)") return false;
  const rest = segments.slice(1).join("/");
  return rest === "sellers" || rest === "sellers/connect";
}

/** (customer)/_layout: where to send the buyer, or null to stay. */
export function customerLayoutTarget(s: {
  hasBuyer: boolean;
  hasSeller: boolean;
  segments: string[];
}): string | null {
  if (!s.hasBuyer) {
    return s.segments[0] === "(auth)" && s.segments[1] === "customer-login" ? null : CUSTOMER_LOGIN;
  }
  if (!s.hasSeller) return isSellerlessRoute(s.segments) ? null : SELLERLESS_LANDING;
  return null;
}

/**
 * Root layout, buyer-only branches (no staff session). `handled: false` means
 * fall through to the existing staff / signed-out logic unchanged.
 */
export function rootBuyerGate(s: {
  hasBuyer: boolean;
  hasSeller: boolean;
  hasStaff: boolean;
  segments: string[];
}): { handled: boolean; to: string | null } {
  if (!s.hasBuyer || s.hasStaff) return { handled: false, to: null };
  if (s.hasSeller) {
    // RF-218: land on the dashboard home tab.
    return { handled: true, to: s.segments[0] === "(customer)" ? null : CUSTOMER_HOME };
  }
  return { handled: true, to: isSellerlessRoute(s.segments) ? null : SELLERLESS_LANDING };
}
