/**
 * Canonical Plans & Billing vocabulary — the single source of truth shared by the
 * entitlements engine, guards, seed, and admin editor. Mirrors the seeded catalog
 * (migration 20260708120000_billing_plans_v2) and
 * docs/design-package/project/specs/pricing-plans.md.
 */

/** The four plan keys (drive entitlement logic; the TenantPlan enum is a shadow). */
export const PLAN_KEYS = ["STARTER", "TEAM", "BUSINESS", "ENTERPRISE"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

/** The 16 feature-flag / addon keys enforced server-side (pricing-plans.md §Feature-flag keys). */
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
] as const;
export type FlagKey = (typeof FLAG_KEYS)[number];

/** Ordinal rank of a plan key (STARTER=0 … ENTERPRISE=3); -1 if unknown. Upgrade/downgrade direction. */
export function planRank(planKey: string): number {
  return PLAN_KEYS.indexOf(planKey as PlanKey);
}

/** The 7 add-on SKUs (pricing-plans.md §Add-on SKUs). */
export const ADDON_SKUS = [
  "SEAT_EXTRA",
  "BUYER_PORTAL",
  "REGULATED_ITEMS",
  "OCR_PACK_250",
  "FORECASTING",
  "ROUTE_EXTRA",
  "MSG_BUNDLE_500",
] as const;
export type AddonSkuCode = (typeof ADDON_SKUS)[number];

/** Meter keys (mirror the Prisma MeterKey enum). */
export const METER_KEYS = ["SEATS", "ROUTES", "SCANS", "MSGS"] as const;
export type MeterKeyCode = (typeof METER_KEYS)[number];

/** BillingEvent type codes (audit + MRR reconciliation). */
export const BILLING_EVENTS = {
  PLAN_CHANGED: "plan.changed",
  PLAN_DOWNGRADE_SCHEDULED: "plan.downgrade_scheduled",
  ADDON_ENABLED: "addon.enabled",
  ADDON_DISABLED: "addon.disabled",
  SEAT_ADDED: "seat.added",
  SEAT_FREED: "seat.freed",
  GRACE_STARTED: "grace.started",
  GRACE_EXPIRED: "grace.expired",
  TRIAL_CONVERTED: "trial.converted",
  TRIAL_EXPIRED: "trial.expired",
  SUBSCRIPTION_CANCELED: "subscription.canceled",
  SUBSCRIPTION_SUSPENDED: "subscription.suspended",
  SUBSCRIPTION_RESUMED: "subscription.resumed",
} as const;
export type BillingEventType = (typeof BILLING_EVENTS)[keyof typeof BILLING_EVENTS];

/**
 * Map the legacy TenantPlan enum → the new planKey source of truth. PROFESSIONAL
 * maps to BUSINESS (human-confirmed backfill: closest tier by feature set).
 */
export function planKeyFromEnum(plan: string | null | undefined): PlanKey {
  switch (plan) {
    case "TEAM":
      return "TEAM";
    case "BUSINESS":
    case "PROFESSIONAL":
      return "BUSINESS";
    case "ENTERPRISE":
      return "ENTERPRISE";
    case "STARTER":
    default:
      return "STARTER";
  }
}

/**
 * Flag → à-la-carte add-on SKU that grants it. When a plan gate is missing one of
 * these flags the resolution is INLINE_RESOLVE (enable the add-on with proration)
 * rather than LOCKED_PAGE (upgrade the plan). Flags absent from this map can only
 * be unlocked by a plan upgrade.
 */
export const FLAG_TO_ADDON_SKU: Record<string, AddonSkuCode> = {
  "addon.buyer_portal": "BUYER_PORTAL",
  "addon.regulated_items": "REGULATED_ITEMS",
  "flag.forecasting": "FORECASTING",
  "flag.analytics": "FORECASTING",
};

/**
 * Legacy free-text addonKey → canonical SKU bridge. The existing "tobacco_dealer"
 * addon (read by products/analytics/tobacco) keeps working and resolves to the
 * REGULATED_ITEMS SKU so it grants `addon.regulated_items` without any edit to
 * those modules.
 *
 * Pending bridge: "developer_mode" (packages/types DEVELOPER_MODE_ADDON) is a
 * hidden platform-admin-toggled legacy addon that unlocks in-development
 * dispatch/driver/route UI (web + mobile, gated client-side via useDeveloperMode).
 * No DEV_MODE AddonSku exists yet — when the catalog grows one, map it here to
 * grant `flag.dispatch_live`. Do not add the mapping until that SKU exists.
 */
export const LEGACY_ADDON_KEY_TO_SKU: Record<string, AddonSkuCode> = {
  tobacco_dealer: "REGULATED_ITEMS",
};

/** Resolve an active TenantAddon row to its canonical SKU code (or null if unknown). */
export function addonSkuCode(row: { sku?: string | null; addonKey: string }): string | null {
  return row.sku ?? LEGACY_ADDON_KEY_TO_SKU[row.addonKey] ?? null;
}
