/**
 * Canonical Plans & Billing vocabulary — the single source of truth shared by the
 * entitlements engine, guards, seed, and admin editor. The live catalog itself is
 * versioned in the database (`PlanVersion` / `PlanDefinition` / `AddonSku`, see
 * `plan-catalog.service.ts`); this file is the fixed vocabulary those rows are
 * written and read against — plan keys, flag keys, addon SKUs, and meter keys.
 */

/** The four plan keys (drive entitlement logic; the TenantPlan enum is a shadow). */
export const PLAN_KEYS = ["STARTER", "GROWTH", "SCALE", "ENTERPRISE"] as const;
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

/**
 * Historical plan keys from catalog versions published before the
 * Starter/Growth/Scale rename. Superseded versions keep their original rows, so
 * anything that reads a pinned older version must normalize before ranking.
 */
export const LEGACY_PLAN_KEY_ALIASES: Record<string, PlanKey> = {
  TEAM: "GROWTH",
  BUSINESS: "SCALE",
  PROFESSIONAL: "SCALE",
};

/** Map any historical or current plan key onto a current one. */
export function normalizePlanKey(planKey: string | null | undefined): PlanKey | null {
  if (!planKey) return null;
  if ((PLAN_KEYS as readonly string[]).includes(planKey)) return planKey as PlanKey;
  // Object.hasOwn (not a bare index) so prototype keys — __proto__, constructor,
  // toString, valueOf… — can't resolve to a truthy inherited member that slips past
  // `?? null` and gets ranked/keyed as if it were a plan. Unknown OR inherited → null.
  return Object.hasOwn(LEGACY_PLAN_KEY_ALIASES, planKey) ? LEGACY_PLAN_KEY_ALIASES[planKey] : null;
}

/** Ordinal rank of a plan key (STARTER=0 … ENTERPRISE=3); -1 if unknown. Upgrade/downgrade direction. */
export function planRank(planKey: string): number {
  const normalized = normalizePlanKey(planKey);
  return normalized ? PLAN_KEYS.indexOf(normalized) : -1;
}

/**
 * Find a catalog definition by plan key, NORMALIZING both sides so a stored key and a
 * pinned version that disagree about the rename still resolve to the same row — a v7-pinned
 * tenant carrying SCALE matches the BUSINESS row, a v8 tenant carrying legacy TEAM matches
 * GROWTH. Use this everywhere a STORED planKey is looked up in a catalog version; a raw
 * `d.planKey === key` compare there silently degrades the tenant to the fallback plan.
 */
export function findPlanDefinition<T extends { planKey: string }>(
  definitions: readonly T[],
  planKey: string | null | undefined,
): T | undefined {
  if (!planKey) return undefined;
  const want = normalizePlanKey(planKey) ?? planKey;
  return definitions.find((d) => (normalizePlanKey(d.planKey) ?? d.planKey) === want);
}

/** The 8 add-on SKUs (pricing-plans.md §Add-on SKUs). */
export const ADDON_SKUS = [
  "SEAT_EXTRA",
  "BUYER_PORTAL",
  "REGULATED_ITEMS",
  "OCR_PACK_250",
  "FORECASTING",
  "ROUTE_EXTRA",
  "MSG_BUNDLE_500",
  "CUSTOMER_PACK_100",
] as const;
export type AddonSkuCode = (typeof ADDON_SKUS)[number];

/** Meter keys (mirror the Prisma MeterKey enum). */
export const METER_KEYS = ["SEATS", "ROUTES", "SCANS", "MSGS", "CUSTOMERS"] as const;
export type MeterKeyCode = (typeof METER_KEYS)[number];

/**
 * Soft-cap grace window, in days. Going over a metered cap never fails the work
 * that breached it — it opens a grace window instead. Shared by
 * `BillingCronService.expireGrace()` (which clears expired windows hourly) and by
 * the synchronous cap gates that must apply the SAME threshold without waiting
 * for the cron to run. One number, one place.
 */
export const GRACE_DAYS = 7;

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
 * Map the legacy TenantPlan enum → the current planKey source of truth. TEAM maps
 * to GROWTH and BUSINESS/PROFESSIONAL map to SCALE (human-confirmed backfill:
 * closest tier by feature set under the Starter/Growth/Scale rename).
 */
export function planKeyFromEnum(plan: string | null | undefined): PlanKey {
  switch (plan) {
    case "TEAM":
      return "GROWTH";
    case "BUSINESS":
    case "PROFESSIONAL":
      return "SCALE";
    case "ENTERPRISE":
      return "ENTERPRISE";
    case "STARTER":
    default:
      return "STARTER";
  }
}

/** Values of the legacy Prisma `TenantPlan` enum (mirrored here, like METER_KEYS, not imported). */
export type TenantPlanEnumValue = "STARTER" | "TEAM" | "BUSINESS" | "PROFESSIONAL" | "ENTERPRISE";

/**
 * Current planKey → the legacy `TenantPlan` enum shadow column. The Prisma enum was NOT
 * renamed with the catalog (it still knows only STARTER|TEAM|BUSINESS|PROFESSIONAL|ENTERPRISE),
 * so a raw `planKey as TenantPlan` cast writing GROWTH/SCALE compiles but fails Prisma enum
 * validation at runtime. Every write to `Tenant.plan` / `TenantSubscription.currentPlan` must go
 * through here; entitlement logic keeps reading the string `planKey`, never this shadow.
 * Inverse of `planKeyFromEnum()`.
 */
export function planKeyToEnum(planKey: string | null | undefined): TenantPlanEnumValue {
  switch (normalizePlanKey(planKey)) {
    case "GROWTH":
      return "TEAM";
    case "SCALE":
      return "BUSINESS";
    case "ENTERPRISE":
      return "ENTERPRISE";
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
 * The free-text key "developer_mode" is intentionally NOT mapped here — no
 * DEV_MODE sku exists in the catalog, so it resolves to `null` via addonSkuCode().
 */
export const LEGACY_ADDON_KEY_TO_SKU: Record<string, AddonSkuCode> = {
  tobacco_dealer: "REGULATED_ITEMS",
};

/** Resolve an active TenantAddon row to its canonical SKU code (or null if unknown). */
export function addonSkuCode(row: { sku?: string | null; addonKey: string }): string | null {
  return row.sku ?? LEGACY_ADDON_KEY_TO_SKU[row.addonKey] ?? null;
}
