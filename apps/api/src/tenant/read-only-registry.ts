/**
 * SA-776 (row 382): the ONE registry of what a READ_ONLY tenant may still write, and the reviewed classification of
 * every other mutating route that the global `TenantStatusGuard` does NOT see as a tenant staff session.
 *
 * Three constants, one pin (`read-only-route-pin.spec.ts`) over every mutating route in the Nest module graph:
 *  - `READ_ONLY_ALLOWED_MUTATIONS` - the guard's allow-list. The guard READS this constant; there is no second copy.
 *    A staff-JWT mutating route is REFUSED under READ_ONLY unless it matches an entry here (so a NEW route is
 *    guarded by default, and an allow-list entry is a deliberate, reasoned act).
 *  - `BUYER_ACCOUNT_WRITES` - buyer-JWT writes that carry no `BuyerSellerContextGuard` (the buyer's own account, or a
 *    link that does not exist yet). A buyer token has no `tenantId`, so the global guard never sees these.
 *  - `PUBLIC_WRITE_ROUTES` - writes with no JWT at all (sign-in, webhooks, public forms).
 *
 * Every entry carries a non-empty `reason`; the pin fails on an unclassified route and on a dead entry.
 */

export type ReadOnlyMethod = "ANY" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ReadOnlyAllowedMutation {
  method: ReadOnlyMethod;
  /** Anchored against the full path, global prefix included (`/api/v1/...`). Never a substring. */
  pattern: RegExp;
  reason: string;
}

/**
 * The ONE read-only allow-list (SA-733r6 / SA-750r3 O1): the only non-read requests a READ_ONLY tenant may make.
 * Anchored patterns, never substrings, so a neighbouring route cannot ride in. Route-scoped, never a role bypass.
 * Everything else (sales, orders, invoices, estimates, payments) stays refused with 403 READ_ONLY.
 */
export const READ_ONLY_ALLOWED_MUTATIONS: ReadonlyArray<ReadOnlyAllowedMutation> = [
  {
    method: "ANY",
    pattern: /^\/api\/v1\/auth\//,
    reason:
      "sign-in, token refresh, sign-out, the user's own password and sessions, OAuth: a tenant must always be able to sign in and keep its session",
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/billing\/subscribe$/,
    reason: "the plan-restore path: a read-only tenant buys its way back to full access",
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/billing\/quote$/,
    reason: "a price quote (no state change) that the choose-plan screen fires before subscribe",
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/billing\/subscription$/,
    reason: "the plan-restore path: start or change the subscription",
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/billing\/subscription\/(downgrade|cancel|resume|checkout)$/,
    reason:
      "the subscription's own lifecycle (downgrade, cancel, resume, checkout) stays with the tenant admin",
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/billing\/payment-due\/pay$/,
    reason:
      "the admin's Pay now for the catch-up amount due: paying the bill is how read-only ends",
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/billing\/portal$/,
    reason: "the admin's card / invoice portal: paying the bill is how read-only ends",
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/orders\/counter-sale\/day-close$/,
    reason:
      "end-of-day close (and the re-close, the same POST): housekeeping on cash already taken (SA-750r3 O1)",
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/orders\/counter-sale\/day-close\/[0-9a-fA-F-]{36}\/reopen$/,
    reason:
      "reopening a closed day to correct it (SA-750r3 O1); the re-close is the same POST above",
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/orders\/counter-sale\/day-close\/[0-9a-fA-F-]{36}\/report$/,
    reason: "the Z-report re-send: log-only, counts as an export",
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/orders\/[0-9a-fA-F-]{36}\/receipt$/,
    reason:
      "the e-mailed receipt of an EXISTING sale: counts as print / export, only the send log is written",
  },
];

export function isReadOnlyAllowedMutation(method: string, path: string): boolean {
  const m = method.toUpperCase();
  return READ_ONLY_ALLOWED_MUTATIONS.some(
    (e) => (e.method === "ANY" || e.method === m) && e.pattern.test(path),
  );
}

/** A route key is `"<VERB> <declared path>"`, exactly as the route table prints it (`:param` names as declared). */
export interface ClassifiedRoute {
  route: string;
  reason: string;
}

/**
 * Buyer-JWT writes WITHOUT `BuyerSellerContextGuard`. A seller-scoped buyer write carries that guard (the gate that
 * stops a READ_ONLY seller taking buyer writes); these act on the buyer's own account or on a link, so they have no
 * seller CONTEXT for the guard. The two that create a link toward a seller ask the same shared rule in the service
 * (`buyer/seller-status-gate.ts`); the rest touch no seller.
 */
export const BUYER_ACCOUNT_WRITES: ReadonlyArray<ClassifiedRoute> = [
  {
    route: "POST /api/v1/buyer/invites/:token/accept",
    reason:
      "links the buyer to a seller by invite token; gated by the shared seller-status rule (buyer/seller-status-gate.ts), dark by default",
  },
  {
    route: "POST /api/v1/buyer/sellers/request",
    reason:
      "asks to connect with a seller the buyer is not yet linked to; gated by the shared seller-status rule (buyer/seller-status-gate.ts), dark by default",
  },
  {
    route: "DELETE /api/v1/buyer/sellers/:sellerSlug",
    reason:
      "a buyer leaving a seller only removes a link and must stay possible whatever the seller's state",
  },
  {
    route: "POST /api/v1/buyer/auth/merge-request",
    reason: "a buyer's request to merge their OWN accounts; touches no seller",
  },
  ...(
    [
      ["DELETE", "account", "deleting the buyer's own account"],
      ["POST", "change-password", "the buyer's own password"],
      ["POST", "handoff", "minting a one-time web/app handoff for the buyer's own session"],
      ["POST", "logout", "ending the buyer's own session"],
      ["PATCH", "profile", "the buyer's own profile"],
      ["POST", "resend-verification", "re-sending the buyer's own e-mail verification"],
      ["DELETE", "sessions/:id", "revoking one of the buyer's own sessions"],
      ["POST", "set-password", "the buyer's own password"],
    ] as const
  ).map(([verb, tail, why]) => ({
    route: `${verb} /api/v1/buyer/auth/${tail}`,
    reason: `buyer account: ${why}; no seller is involved`,
  })),
];

/** Writes with no JWT at all: sign-in, webhooks (verified by signature), public forms. */
export const PUBLIC_WRITE_ROUTES: ReadonlyArray<ClassifiedRoute> = [
  ...(
    [
      ["apple", "Sign in with Apple (identity token verified in the handler)"],
      ["apple/nonce", "issues the Apple sign-in nonce"],
      ["apple/notifications", "Apple server-to-server notification (signature verified)"],
      ["google/exchange", "Google OAuth code exchange"],
      ["handoff/exchange", "redeems a one-time handoff token into a session"],
      ["login", "password sign-in"],
      ["refresh", "refresh-token rotation"],
      ["request-password-reset", "password-reset request (always answers the same)"],
      ["reset-password", "password reset by emailed token"],
      ["verify-email", "e-mail verification by emailed token"],
    ] as const
  ).map(([tail, why]) => ({
    route: `POST /api/v1/auth/${tail}`,
    reason: `staff auth, pre-session: ${why}`,
  })),
  ...(
    [
      ["handoff/exchange", "redeems a one-time handoff token into a buyer session"],
      ["login", "buyer password sign-in"],
      ["refresh", "buyer refresh-token rotation"],
      ["register", "buyer self-registration (no tenant yet)"],
      ["request-password-reset", "buyer password-reset request"],
      ["reset-password", "buyer password reset by emailed token"],
      ["verify-email", "buyer e-mail verification by emailed token"],
      ["verify-merge", "buyer account-merge confirmation by emailed token"],
    ] as const
  ).map(([tail, why]) => ({
    route: `POST /api/v1/buyer/auth/${tail}`,
    reason: `buyer auth, pre-session: ${why}`,
  })),
  {
    route: "POST /api/v1/billing/webhook",
    reason: "the platform billing webhook; verified by Stripe signature, not a tenant session",
  },
  {
    route: "POST /api/v1/billing/webhook/connect",
    reason:
      "the Connect webhook records money arriving (buyer payments are exempt from the buyer gate), allowed by class (SA-776 GAP-3)",
  },
  ...(
    [
      ["", "a prospect books a demo"],
      ["/cancel", "a prospect cancels their own demo booking (token)"],
      ["/reschedule", "a prospect reschedules their own demo booking (token)"],
    ] as const
  ).map(([tail, why]) => ({
    route: `POST /api/v1/public/demo-bookings${tail}`,
    reason: `public demo booking: ${why}`,
  })),
  ...(
    [
      ["accept", "accepts the onboarding terms by link token"],
      ["files", "uploads an onboarding intake file by link token"],
      ["files/delete", "removes an onboarding intake file by link token"],
      ["sections/save", "saves an onboarding section by link token"],
      ["sections/submit", "submits an onboarding section by link token"],
      ["session", "opens an onboarding session by link token"],
    ] as const
  ).map(([tail, why]) => ({
    route: `POST /api/v1/public/onboarding/${tail}`,
    reason: `public onboarding intake (token-bound, no tenant session): ${why}`,
  })),
  {
    route: "POST /api/v1/public/tenants/register",
    reason: "self-serve tenant registration: the tenant does not exist yet",
  },
  {
    route: "POST /api/v1/public/tenants/resend-verification",
    reason: "re-sends the registration verification e-mail (pre-session)",
  },
];
