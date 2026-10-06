// ─── Billing vocabulary + shared DTOs (WP1, lite-L2 lane) ──────────────────────
//
// Mirrors `apps/api/src/billing/plan-catalog.constants.ts`'s `FLAG_KEYS` — the API mirrors this
// locally rather than value-importing it (the API compiles to `dist/` via `nest build`, which
// does not bundle workspace deps; see that file's REG-743-F1 note), so the two are pinned
// set-equal by `apps/api/src/common/enum-parity.spec.ts`'s WP1 T2 case. Keep both lists in sync
// by hand.

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
   *  guard recorded (`"trial_expired"` | `"subscription_cancelled"` | `"trial_cancelled"`, or
   *  another server-defined string). `null`/absent renders the generic read-only copy. */
  readOnlyReason?: string | null;
  addons: Array<{ sku: string | null; name: string; quantity: number; monthly: number | null }>;
  flags?: string[];
  paymentRequired: boolean;
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
