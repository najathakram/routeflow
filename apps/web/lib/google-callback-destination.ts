/**
 * Where a buyer's Google sign-in lands. `linked=true` only when the sign-in actually activated a link; when the
 * invite's seller is not taking it the buyer still lands signed in, with `invite=seller_unavailable` (the portal
 * shows one fixed neutral notice). Anything else lands plain.
 */
export function buyerLandingDestination(linked: string | null, invite: string | null): string {
  if (linked === "true") return "/buyer/portal?linked=true";
  if (invite === "seller_unavailable") return "/buyer/portal?invite=seller_unavailable";
  return "/buyer/portal";
}
