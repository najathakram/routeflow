// ─── Billing vocabulary + shared DTOs (WP1, lite-L2 lane) ──────────────────────
//
// Mirrors `apps/api/src/billing/plan-catalog.constants.ts`'s `FLAG_KEYS` — the API mirrors this
// locally rather than value-importing it (the API compiles to `dist/` via `nest build`, which
// does not bundle workspace deps; see that file's REG-743-F1 note), so the two are pinned
// set-equal by `apps/api/src/common/enum-parity.spec.ts`'s WP1 T2 case. Keep both lists in sync
// by hand.

import type { ApiErrorCode } from "./error-codes";

/** The 21 feature-flag / addon keys enforced server-side (pricing-plans.md §Feature-flag keys). */
export const FLAG_KEYS = [
  "flag.dispatch_live",
  "flag.returns",
  "flag.ap_bills",
  "flag.reports",
  "flag.credit_limits",
  "flag.settlement",
  "flag.pricing_tiers",
  "flag.analytics",
  "flag.forecasting",
  "flag.import_integrations",
  "flag.api_sso",
  "addon.buyer_portal",
  "addon.regulated_items",
  "addon.ocr",
  "flag.msrp",
  "flag.sales_agents",
  "flag.estimates",
  "flag.recurring_invoices",
  "flag.credit_notes",
  "flag.suppliers",
  "flag.messaging",
] as const;
export type FlagKey = (typeof FLAG_KEYS)[number];

/**
 * Mirrors `apps/web/lib/api/billing.ts`'s `SubscriptionView` (the 14 fields defined there) so
 * mobile can share the same shape instead of hand-declaring its own copy — the exact L-072 drift
 * class `packages/types/api/enums.ts` exists to prevent, applied here to a DTO instead of an
 * enum. Generic over `TDate` (default `string`, matching the web shape's ISO-string-over-the-wire
 * fields) so a consumer that parses dates client-side can instantiate `SubscriptionView<Date>`
 * instead of re-declaring the interface with `Date` substituted by hand.
 *
 * `flags` and `paymentRequired` are WP1 additions: `flags` is the resolved list of `FlagKey`
 * strings the tenant's current plan+addons grant (read by client-side gates instead of
 * re-deriving entitlement locally), and `paymentRequired` flags a subscription state where the
 * tenant must supply/update payment before continuing (e.g. converting off an invite-only trial).
 */
export interface SubscriptionView<TDate = string> {
  planKey: string;
  planName: string;
  status: string;
  cycle: "MONTHLY" | "ANNUAL";
  monthlyPrice: number | null;
  annualPrice: number | null;
  isCustom: boolean;
  renewalAt: TDate | null;
  cancelAtPeriodEnd: boolean;
  downgradeToPlanKey: string | null;
  downgradeEffectiveAt: TDate | null;
  trialEndsAt: TDate | null;
  /** Populated only when `status === "READ_ONLY"` — the enforcement reason the tenant-status
   *  guard recorded (`"trial_expired"` | `"subscription_cancelled"` | `"trial_cancelled"` | `"payment_overdue"` (SA-733r7: a dunning pause), or
   *  another server-defined string). `null`/absent renders the generic read-only copy. */
  readOnlyReason?: string | null;
  addons: Array<{ sku: string | null; name: string; quantity: number; monthly: number | null }>;
  flags?: string[];
  paymentRequired: boolean;
  /** SA-733r6 (B4) - the dunning clock and the banner's facts. All optional/null: a tenant that never failed a
   *  payment (and any older server) simply omits them, and the banner then shows the autopay card only. */
  /** When the first failed payment of the open invoice was stamped; day 0 of the 7-day grace. */
  pastDueSince?: TDate | null;
  /** The Stripe invoice the tenant owes; the Pay action is shown whenever this is set. */
  pastDueInvoiceId?: string | null;
  /** The oldest active TENANT_ADMIN's e-mail - who non-admins are told to contact (SA-776). Null when none, or
   *  when it is an internal sentinel address. There is deliberately NO name field: the User model has no display
   *  name and a username is never shown (the old `billingContactName` was the username and is gone). */
  billingContactEmail?: string | null;
  /** The owed invoice's amount remaining, in dollars (always printed as money). */
  openInvoiceAmount?: number | null;
  /** The card autopay will charge (brand / last4 / expiry); null when none or not a card. */
  paymentMethodSummary?: PaymentMethodSummary | null;
  /** What the next renewal charges and when (dollars, ISO date). */
  nextCharge?: { amount: number; date: TDate; dateLabel?: string } | null;
  /** The month the failed charge was for ("November") and the grace deadline ("Nov 8"), formatted by the SERVER in
   *  the tenant's zone - render verbatim, never re-derive a date in the browser's zone. */
  pastDueMonthLabel?: string | null;
  graceEndsLabel?: string | null;
  /** True only when the server will really pause an unpaid workspace (BILLING_PAUSE_MODE=enforced). In dark / off the
   *  banner never threatens a read-only date. */
  pauseEnforced?: boolean;
}

/**
 * The 403 body of a write refused while the workspace is READ_ONLY (SA-776; `TenantStatusGuard`). `reason` is the
 * tenant's recorded `readOnlyReason` (null = set by an administrator). Clients compose their copy from the
 * subscription view through `@routeflow/types/read-only-copy` and never render `message`.
 */
export interface ReadOnlyErrorBody {
  /** Always `API_ERROR_CODES.READ_ONLY` (compare through the constant, never a literal). */
  code: ApiErrorCode;
  reason: string | null;
  message: string;
}

/** The autopay card shown on the Billing card ("Your Visa ending 4242 expires Oct 31"). */
export interface PaymentMethodSummary {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

/** `POST /billing/portal` (TENANT_ADMIN): the Stripe portal to update the card, and - while an invoice is
 *  owed - its hosted page to pay it. */
export interface BillingPortalResult {
  /** Null when only the pay link could be produced (a portal outage never loses the pay link). */
  portalUrl: string | null;
  hostedInvoiceUrl: string | null;
}

/**
 * How a tenant's self-serve add-on is billed (`GET /billing/proration-preview` and the enable
 * response): STRIPE = prorated onto the next Stripe bill; MANUAL = the owner adds it to the next
 * manual invoice; UNBILLED = no Stripe subscription, so nothing is charged online. A TYPE only (no
 * runtime value), so the API's own `AddonBilling` aliases it with `import type` and the two can
 * never drift; the API must never value-import this package (prod boots from compiled CJS).
 */
export type AddonBillingMode = "STRIPE" | "MANUAL" | "UNBILLED";

/**
 * The body of `POST /billing/addons/:sku/enable`: what REALLY happened. `proratedNow` is Stripe's
 * own prorated figure for a STRIPE tenant (null when it could not be read back), 0 for UNBILLED and
 * null/0 for MANUAL; `subscription` is the refreshed subscription view.
 */
export interface EnableAddonResult {
  proratedNow: number | null;
  billing: AddonBillingMode;
  subscription: SubscriptionView;
}
