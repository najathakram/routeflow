/**
 * Canonical Plans & Billing vocabulary — the single source of truth shared by the
 * entitlements engine, guards, seed, and admin editor. The live catalog itself is
 * versioned in the database (`PlanVersion` / `PlanDefinition` / `AddonSku`, see
 * `plan-catalog.service.ts`); this file is the fixed vocabulary those rows are
 * written and read against — plan keys, flag keys, addon SKUs, and meter keys.
 */

// REG-743-F1: mirrors @routeflow/types's PLAN_KEYS here (like METER_KEYS below), rather than
// value-importing it. The API compiles to dist/ via `nest build`, which does not bundle
// workspace deps; @routeflow/types ships raw TypeScript with no build step, so a value import
// crashes `node dist/main.js` at boot (see no-runtime-workspace-imports.spec.ts) — only
// @routeflow/pricing ships a compiled `main` and may be value-imported here. The previous
// hand-typed copy this replaced was `["STARTER", "PROFESSIONAL", "ENTERPRISE"]`, missing
// GROWTH/SCALE and carrying a non-existent "PROFESSIONAL" key.
//
// WP1 (lite-L2, R1.1-R1.4): LITE is an invite-only tier ranked BELOW every existing plan, so it
// leads the array. `planRank()` below derives a plan's ordinal from `PLAN_KEYS.indexOf(...)`, so
// this is an ORDER PIN, not a set of hardcoded indices — LITE=0, STARTER=1, GROWTH=2, SCALE=3,
// ENTERPRISE=4, and any future re-tiering only needs to reorder this array.
export const PLAN_KEYS = ["LITE", "STARTER", "GROWTH", "SCALE", "ENTERPRISE"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

/**
 * Invite-only plan keys (WP1, R3a.1): a tenant can only land on one of these via an explicit
 * platform-admin action, never public self-signup. Today that's just LITE.
 */
export const INVITE_ONLY_PLAN_KEYS: readonly PlanKey[] = ["LITE"] as const;

/** True when `planKey` is one of `INVITE_ONLY_PLAN_KEYS`. */
export const isInviteOnlyPlanKey = (planKey: string | null | undefined): boolean =>
  planKey != null && (INVITE_ONLY_PLAN_KEYS as readonly string[]).includes(planKey);

/**
 * Invite-only plans whose entitlement gates are ALWAYS enforced, regardless of any dark/enforced
 * rollout switch elsewhere in the billing system (R3a.7). Must stay a subset of
 * `INVITE_ONLY_PLAN_KEYS` — see the `enum-parity`/`plan-catalog.constants` specs' subset check.
 */
export const ALWAYS_ENFORCED_PLAN_KEYS: ReadonlySet<PlanKey> = new Set<PlanKey>(["LITE"]);

/** True when `planKey` is in `ALWAYS_ENFORCED_PLAN_KEYS`. */
export const isAlwaysEnforcedPlan = (planKey: string | null | undefined): boolean =>
  planKey != null && (ALWAYS_ENFORCED_PLAN_KEYS as ReadonlySet<string>).has(planKey);

/**
 * Q1 lever: whether an invite-only plan may be self-serve checked out once a tenant has been
 * invited onto it, vs. requiring a platform-admin-driven activation. Defaults to allowed.
 */
export const INVITE_ONLY_PLAN_SELF_SERVE_CHECKOUT = true;

/** Gates self-serve checkout: always allowed for a non-invite-only plan; lever-gated otherwise. */
export const inviteOnlyCheckoutAllowed = (
  planKey: string | null | undefined,
  lever: boolean = INVITE_ONLY_PLAN_SELF_SERVE_CHECKOUT,
): boolean => !isInviteOnlyPlanKey(planKey) || lever;

/** Q3 lever: trial length (days) for an invite-only plan. LITE ships with no trial. */
export const INVITE_ONLY_PLAN_TRIAL_DAYS = 0;

/** Q4: the display name for LITE — no UI hardcodes the word "Lite" anywhere else. */
export const LITE_PLAN_DISPLAY_NAME = "Lite";

/**
 * Default trial length in days. Consumed by `tenants.service.ts` (public self-signup) AND
 * `platform-admin.service.ts`'s Create Tenant path (`dto.trialLengthDays ?? TRIAL_LENGTH_DAYS`)
 * — both are wired to this constant; REG-743-F6 (a declaration defect, not a code defect) fixes
 * an earlier version of this comment that claimed the admin path still hardcoded its own 7-day
 * value. The admin path also accepts an explicit 1-90 day override
 * (`CreateTenantDto.trialLengthDays`, REG-743-N7) that takes precedence over this default.
 */
export const TRIAL_LENGTH_DAYS = 14;

/**
 * Enforcement status of these flags, as of the WP1-WP3 kill-switch rollout
 * (`PLAN_FLAG_ENFORCEMENT` env, default off — see plan-flag.guard.ts). This
 * lists what the guard/decorator wiring covers once the switch flips on; it
 * does not itself gate anything.
 *
 * ENFORCED — `@RequirePlanFlag` (guard/decorator) or an equivalent
 * service-level check:
 *   - flag.analytics — AnalyticsController (class-level)
 *   - flag.ap_bills — VendorBillsController (class-level)
 *   - flag.import_integrations — MigrationController only; the CSV import
 *     controllers (import/batch/alias/numbering/resolution) stay ungated —
 *     core onboarding.
 *   - flag.forecasting — InventoryController: GET forecasting,
 *     PATCH products/:id/reorder-settings
 *   - flag.pricing_tiers — CustomersController: the three
 *     /customers/:id/prices* handlers
 *   - flag.reports — BookkeepingController: every reports/* GET (summary,
 *     dashboard, transactions, expenses, bills/bulk-mark-paid, and
 *     finance-dashboard stay ungated — core money endpoints)
 *   - flag.returns — ReturnsController (class-level; also serves
 *     CUSTOMER/DRIVER roles, so stays behind the kill switch until the
 *     v7-STARTER question in the WP4 audit is answered)
 *   - flag.credit_limits — OrdersService.assertWithinCreditLimit
 *     (service-level, no route of its own; gates the CHECK only — an
 *     unflagged tenant's stored creditLimit values stay inert, not deleted)
 *
 * RESERVED — no code exists yet to gate, so no decorator:
 *   - flag.api_sso — no SSO implementation exists.
 *   - flag.settlement — no driver run-settlement feature exists (distinct
 *     from Stripe Connect payment settlement, which is unrelated and
 *     already live).
 *
 * DELIBERATELY UNENFORCED:
 *   - flag.dispatch_live — v8 grants this to no plan tier. Dispatch is
 *     already UI-gated by the `developer_mode` addon; enforcing it
 *     server-side too would break the e2e canary and the sales demo
 *     tenant, which rely on that UI gate rather than a plan entitlement.
 *
 * All other keys below (addon.buyer_portal, addon.regulated_items,
 * addon.ocr, flag.msrp) are untouched by this rollout. flag.msrp in particular
 * was already enforced on POST /products/msrp/bulk (#411) and sits OUTSIDE the
 * kill switch (see DARK_PLAN_FLAGS in plan-flag.guard.ts) — it keeps enforcing
 * whatever PLAN_FLAG_ENFORCEMENT is set to.
 */
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

/** Ordinal rank of a plan key (LITE=0 … ENTERPRISE=4); -1 if unknown. Upgrade/downgrade direction. */
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
  "MSRP",
  "SALES_AGENTS",
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
  /** TRIAL-1: tenant self-serve "End trial" — see SubscriptionMutationService.cancel(). */
  TRIAL_CANCELLED: "trial.cancelled",
  SUBSCRIPTION_CANCELED: "subscription.canceled",
  SUBSCRIPTION_SUSPENDED: "subscription.suspended",
  SUBSCRIPTION_RESUMED: "subscription.resumed",
  // Phase 0 T8: a tenant's classification changed via the platform-admin override endpoint.
  // Only emitted when the change crosses into or out of PRODUCTION (see
  // PlatformAdminService.updateTenantClass) — that's the transition that moves revenue in or
  // out of MrrService's scope, so it's the one worth a ledger row.
  TENANT_CLASS_CHANGED: "tenant.class_changed",
  // REG-743-N8: emitted by scripts/backfill-subscription-reconciliation.mjs on a successful
  // --apply write. Declared here for discoverability even though the .mjs CANNOT import this
  // TS const (it's a plain script, no compile step) — it re-types the same string literal
  // itself; keep the two in sync by hand if this key's string ever changes.
  RECONCILIATION_SNAPSHOT_BACKFILLED: "reconciliation.snapshot_backfilled",
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
    // Phase 0 Task 10: GROWTH/SCALE are now also DIRECT TenantPlan enum values (not only
    // legacy aliases mapped forward) — identity map them instead of falling through to the
    // STARTER default, which used to silently under-price/under-entitle a tenant written with
    // the new enum value directly.
    case "GROWTH":
      return "GROWTH";
    case "SCALE":
      return "SCALE";
    case "ENTERPRISE":
      return "ENTERPRISE";
    // WP1 (lite-L2): LITE is now a direct TenantPlan enum value too — identity map it rather
    // than falling through to the STARTER default.
    case "LITE":
      return "LITE";
    case "STARTER":
    default:
      return "STARTER";
  }
}

/**
 * Values of the Prisma `TenantPlan` enum (mirrored here, like METER_KEYS, not imported). Phase 0
 * (docs/superpowers/plans/2026-09-12-backoffice-phase-0-truth.md) widened the enum with GROWTH
 * and SCALE ahead of Task 10's catalog entries — see `SELECTABLE_TENANT_PLANS` below for which of
 * these are currently acceptable on a write DTO.
 */
export type TenantPlanEnumValue =
  "STARTER" | "TEAM" | "BUSINESS" | "PROFESSIONAL" | "ENTERPRISE" | "GROWTH" | "SCALE" | "LITE";

/**
 * `TenantPlan` values currently selectable on an admin-facing DTO (`UpdateTenantPlanDto`,
 * `ActivateSubscriptionDto`). Phase 0 Task 10 closed the GROWTH/SCALE gap: `planKeyFromEnum()`
 * now identity-maps both, so they're safe to accept here too. WP1 (lite-L2) adds LITE — it's
 * invite-only (see `INVITE_ONLY_PLAN_KEYS`), not publicly self-serve, but still a value an
 * admin-facing DTO must accept when activating an invited tenant.
 */
export const SELECTABLE_TENANT_PLANS: TenantPlanEnumValue[] = [
  "STARTER",
  "TEAM",
  "BUSINESS",
  "PROFESSIONAL",
  "ENTERPRISE",
  "GROWTH",
  "SCALE",
  "LITE",
];

/**
 * Current planKey → the legacy `TenantPlan` enum shadow column. The Prisma enum was NOT
 * renamed with the catalog (it still knows only STARTER|TEAM|BUSINESS|PROFESSIONAL|ENTERPRISE),
 * so a raw `planKey as TenantPlan` cast writing GROWTH/SCALE compiles but fails Prisma enum
 * validation at runtime. Every write to `Tenant.plan` / `TenantSubscription.currentPlan` must go
 * through here; entitlement logic keeps reading the string `planKey`, never this shadow.
 * Inverse of `planKeyFromEnum()`.
 *
 * B218: this is a pure mapping function — it does NOT validate `planKey` against the live
 * catalog, and it must not silently paper over a key it cannot map. THROWS for anything
 * `normalizePlanKey` cannot resolve (neither in `PLAN_KEYS` nor `LEGACY_PLAN_KEY_ALIASES`) —
 * it used to fall through to `STARTER` here, which under-entitled a tenant actually on a
 * published-but-off-vocabulary tier (e.g. a catalog publishing typo) with no error anywhere.
 * Every caller MUST handle the throw explicitly for whatever "loud" means on that path (a
 * 400 for a client-supplied key, a logged skip for one bad row in a cron sweep) — never catch
 * it only to re-default to STARTER, which is exactly the bug this closes.
 */
/**
 * CHANGE-2 (2026-09-13): dedicated error class for `planKeyToEnum()`'s unresolvable-key case,
 * so a caller can discriminate it with `instanceof` instead of matching a message PREFIX
 * (`billing-cron.service.ts`'s `isUnresolvablePlanKeyError()` used to do exactly that — a
 * reworded message would have silently stopped discriminating this data problem from a real
 * infrastructure failure). Carries the offending key for logging. The message text is
 * unchanged from the plain-`Error` original so nothing that reads it regresses.
 */
export class UnknownPlanKeyError extends Error {
  constructor(public readonly planKey: string | null | undefined) {
    super(
      `planKeyToEnum: unrecognized plan key "${planKey}" — not in PLAN_KEYS or LEGACY_PLAN_KEY_ALIASES`,
    );
    this.name = "UnknownPlanKeyError";
  }
}

export function planKeyToEnum(planKey: string | null | undefined): TenantPlanEnumValue {
  const normalized = normalizePlanKey(planKey);
  switch (normalized) {
    case "GROWTH":
      return "TEAM";
    case "SCALE":
      return "BUSINESS";
    case "ENTERPRISE":
      return "ENTERPRISE";
    case "STARTER":
      return "STARTER";
    // WP1 (lite-L2): LITE is a direct TenantPlan enum value (added by the
    // 20260915000000_tenant_plan_lite migration) — identity map it like GROWTH/SCALE above.
    case "LITE":
      return "LITE";
    default:
      throw new UnknownPlanKeyError(planKey);
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
  "flag.msrp": "MSRP",
  "flag.sales_agents": "SALES_AGENTS",
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
  msrp: "MSRP",
  sales_agents: "SALES_AGENTS",
  // Bridges the @RequireAddon("ocr") scan gate to the catalog's OCR pack SKU so
  // enabling the addon bills the SKU (when Stripe is on) and SKU activation and
  // the admin toggle converge on the same TenantAddon key.
  ocr: "OCR_PACK_250",
};

/** Resolve an active TenantAddon row to its canonical SKU code (or null if unknown). */
export function addonSkuCode(row: { sku?: string | null; addonKey: string }): string | null {
  return row.sku ?? LEGACY_ADDON_KEY_TO_SKU[row.addonKey] ?? null;
}

/**
 * SKUs a TENANT_ADMIN may enable from settings→billing. Everything else is
 * platform-admin-only ("ships dark") — owner decision 2026-08-24. SEAT_EXTRA is
 * seat-billing plumbing, never a toggle.
 */
export const SELF_SERVICE_ADDON_SKUS: readonly AddonSkuCode[] = [
  "CUSTOMER_PACK_100",
  "FORECASTING",
] as const;
