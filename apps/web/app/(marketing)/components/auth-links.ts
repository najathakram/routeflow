import type { Side } from "./use-side";

export type AuthMode = "in" | "up";

// Single source of truth for nav, audience-split CTAs, hero CTAs, footer.
// Routes to the existing dedicated auth pages — no modal.
export function getAuthHref(side: Side, mode: AuthMode): string {
  if (side === "retailer") {
    return mode === "in" ? "/buyer/login" : "/buyer/register";
  }
  // neutral and wholesaler both go to the operator auth surface
  return mode === "in" ? "/login" : "/signup";
}
