// PR-0b "zero-loss report" — plain SQL/JS mirror of the feature-grants v2 resolution logic.
//
// MIRROR, NOT SOURCE OF TRUTH (same convention as apps/api/scripts/audit-tenant-entitlements.mjs's
// own header). It exists as a copy only because apps/api/scripts/publish-and-repin.mjs runs
// standalone under plain `node` (invoked via `railway run`) and cannot import the compiled Nest
// app. Any behavioural change to the files below belongs there FIRST, ported here in the SAME PR:
//   - apps/api/src/billing/feature-registry.ts           (FEATURE_REGISTRY — key/gate.via/gate.state/
//                                                          defaultGranted only; requires/conflicts/
//                                                          config/billing.skus are NOT mirrored —
//                                                          they don't change the effective boolean,
//                                                          see the doc comment on EFFECTIVE_KEYS below)
//   - apps/api/src/billing/plan-flag-policy.ts            (DARK_PLAN_FLAGS/PREPIN_DARK_FLAGS/
//                                                          isPlanFlagEnforcementOn/isDarkFlag/allowsFlag)
//   - apps/api/src/billing/plan-catalog.constants.ts       (ALWAYS_ENFORCED_PLAN_KEYS/isAlwaysEnforcedPlan,
//                                                          and the plan-key/addon-sku helpers already
//                                                          mirrored once in audit-tenant-entitlements.mjs —
//                                                          copied again here rather than shared, because
//                                                          a plain script has no module system that
//                                                          reaches across two sibling scripts any more
//                                                          cleanly than it reaches into dist/)
//   - apps/api/src/billing/entitlement-authority.service.ts (EntitlementAuthority.computeOldPathAll —
//                                                          the "old path" branch this file's
//                                                          computeOldPathEffective reproduces)
//   - apps/api/src/billing/feature-resolver.service.ts     (resolveOneKey — the "one rule" branch
//                                                          this file's computeNewPathEffective
//                                                          reproduces)
//
// `apps/api/src/billing/feature-registry-mirror.parity.spec.ts` is the automated version of "keep in
// lock-step": it imports the REAL TypeScript modules above (via ts-jest, which the standalone script
// itself cannot use) and asserts every field below against them. A registry change that isn't ported
// here fails that spec, not just a code comment's promise.
"use strict";

// ─── feature-registry.ts mirror ────────────────────────────────────────────────────────────────
//
// Per key: [key, via, state, defaultGranted].
//   via   — FeatureGateVia: "RequireAddon" | "RequirePlanFlag" | "guard" | "service" | "none"
//   state — the registry row's OWN gate.state ("dark"|"enforced"|"none"), kept verbatim for every
//           row for fidelity/debugging even though only a "RequireAddon" row's state is ever
//           consulted (see addonGateStateMirror below — ADDON_GATE_REGISTRY, and therefore
//           addonGateState(), is derived from RequireAddon rows ONLY; a "guard" row like
//           driver_payments always reads back "enforced" regardless of what its own state field
//           says, because it was never in that projection to begin with).
//   defaultGranted — FeatureDef.defaultGranted; consulted ONLY by the new/one-rule path
//           (computeOldPathAll has no defaultGranted fallback at all — see its own source).
//
// 35 entries, transcribed 2026-09-19 from FEATURE_REGISTRY at origin/master 27d80c21.
const FEATURE_REGISTRY_MIRROR = [
  ["ocr", "RequireAddon", "dark", false],
  ["tobacco_dealer", "RequireAddon", "enforced", false],
  ["recurring_routes", "RequireAddon", "enforced", false],
  ["order_delivery", "RequireAddon", "enforced", false],
  ["crm_gohighlevel", "RequireAddon", "dark", false],
  ["email.connected_mailbox", "RequireAddon", "dark", false],
  ["developer_mode", "RequireAddon", "enforced", false],
  ["driver_payments", "guard", "enforced", false],
  ["orders_inline_returns", "RequireAddon", "enforced", false],
  ["flag.msrp", "RequirePlanFlag", "enforced", false],
  ["flag.sales_agents", "RequirePlanFlag", "enforced", false],
  ["flag.analytics", "RequirePlanFlag", "dark", false],
  ["flag.forecasting", "RequirePlanFlag", "dark", false],
  ["flag.reports", "RequirePlanFlag", "dark", false],
  ["flag.returns", "RequirePlanFlag", "dark", false],
  ["flag.ap_bills", "RequirePlanFlag", "dark", false],
  ["flag.pricing_tiers", "RequirePlanFlag", "dark", false],
  ["flag.import_integrations", "RequirePlanFlag", "dark", false],
  ["flag.estimates", "RequirePlanFlag", "dark", false],
  ["flag.recurring_invoices", "RequirePlanFlag", "dark", false],
  ["flag.credit_notes", "RequirePlanFlag", "dark", false],
  ["flag.suppliers", "RequirePlanFlag", "dark", false],
  ["flag.messaging", "RequirePlanFlag", "dark", false],
  ["addon.buyer_portal", "RequirePlanFlag", "dark", false],
  ["flag.credit_limits", "service", "dark", false],
  ["flag.dispatch_live", "none", "none", false],
  ["flag.settlement", "none", "none", false],
  ["flag.api_sso", "none", "none", false],
  ["limit_seats", "none", "none", false],
  ["limit_routes", "none", "none", false],
  ["limit_customers", "none", "none", false],
  ["metered_scans", "none", "none", false],
  ["metered_msgs", "none", "none", false],
  ["catalog_varieties", "none", "none", true],
  ["routes_dispatch", "none", "none", true],
].map(([key, via, state, defaultGranted]) => ({ key, via, state, defaultGranted }));

// ─── plan-flag-policy.ts mirror ────────────────────────────────────────────────────────────────

/** Mirrors DARK_PLAN_FLAGS in plan-flag-policy.ts verbatim. */
const DARK_PLAN_FLAGS = new Set([
  "flag.analytics",
  "flag.ap_bills",
  "flag.import_integrations",
  "flag.forecasting",
  "flag.pricing_tiers",
  "flag.reports",
  "flag.returns",
  "flag.estimates",
  "flag.recurring_invoices",
  "flag.credit_notes",
  "flag.suppliers",
  "flag.messaging",
  "addon.buyer_portal",
]);

/** Mirrors PREPIN_DARK_FLAGS in plan-flag-policy.ts verbatim. */
const PREPIN_DARK_FLAGS = new Set([
  "flag.estimates",
  "flag.recurring_invoices",
  "flag.credit_notes",
  "flag.suppliers",
  "flag.messaging",
]);

/** Mirrors isPlanFlagEnforcementOn. */
function isPlanFlagEnforcementOn(env) {
  return (env.PLAN_FLAG_ENFORCEMENT ?? "off") === "on";
}

/** Mirrors isDarkFlag. */
function isDarkFlag(flagKey, env) {
  return (
    PREPIN_DARK_FLAGS.has(flagKey) ||
    (DARK_PLAN_FLAGS.has(flagKey) && !isPlanFlagEnforcementOn(env))
  );
}

/** Mirrors allowsFlag. `entFlags` is the tenant's resolved Entitlements.flags array. */
function allowsFlag(planKey, entFlags, flagKey, env) {
  if (isDarkFlag(flagKey, env) && !isAlwaysEnforcedPlan(planKey)) return true;
  return entFlags.includes(flagKey);
}

// ─── plan-catalog.constants.ts mirror (ALWAYS_ENFORCED_PLAN_KEYS slice only — the rest of this
// file's plan-key/addon-sku vocabulary is already mirrored in audit-tenant-entitlements.mjs and is
// re-mirrored below rather than shared, per this file's own header) ────────────────────────────

/** Mirrors ALWAYS_ENFORCED_PLAN_KEYS. */
const ALWAYS_ENFORCED_PLAN_KEYS = new Set(["LITE"]);

/** Mirrors isAlwaysEnforcedPlan. */
function isAlwaysEnforcedPlan(planKey) {
  return planKey != null && ALWAYS_ENFORCED_PLAN_KEYS.has(planKey);
}

const PLAN_KEYS = ["LITE", "STARTER", "GROWTH", "SCALE", "ENTERPRISE"];

/** Mirrors LEGACY_PLAN_KEY_ALIASES. */
const LEGACY_PLAN_KEY_ALIASES = { TEAM: "GROWTH", BUSINESS: "SCALE", PROFESSIONAL: "SCALE" };

/** Mirrors normalizePlanKey. */
function normalizePlanKey(planKey) {
  if (!planKey) return null;
  if (PLAN_KEYS.includes(planKey)) return planKey;
  return Object.hasOwn(LEGACY_PLAN_KEY_ALIASES, planKey) ? LEGACY_PLAN_KEY_ALIASES[planKey] : null;
}

/** Mirrors findPlanDefinition. */
function findPlanDefinition(definitions, planKey) {
  if (!planKey) return undefined;
  const want = normalizePlanKey(planKey) ?? planKey;
  return definitions.find((d) => (normalizePlanKey(d.planKey) ?? d.planKey) === want);
}

/** Mirrors planKeyFromEnum. */
function planKeyFromEnum(plan) {
  switch (plan) {
    case "TEAM":
      return "GROWTH";
    case "BUSINESS":
    case "PROFESSIONAL":
      return "SCALE";
    case "GROWTH":
      return "GROWTH";
    case "SCALE":
      return "SCALE";
    case "ENTERPRISE":
      return "ENTERPRISE";
    case "LITE":
      return "LITE";
    case "STARTER":
    default:
      return "STARTER";
  }
}

/** Mirrors LEGACY_ADDON_KEY_TO_SKU. */
const LEGACY_ADDON_KEY_TO_SKU = {
  tobacco_dealer: "REGULATED_ITEMS",
  msrp: "MSRP",
  sales_agents: "SALES_AGENTS",
  ocr: "OCR_PACK_250",
};

/** Mirrors addonSkuCode. */
function addonSkuCode(row) {
  return row.sku ?? LEGACY_ADDON_KEY_TO_SKU[row.addonKey] ?? null;
}

// ─── the one deliberate deviation from a byte-for-byte mirror ─────────────────────────────────
//
// design.md (local-assets/handoff/2026-09-16/feature-grants-v2/design.md:80-83, "Credit-limit
// check"): "today it always runs ... 'Currently effective' is everyone". `flag.credit_limits` is
// gate.via "service" and is NOT a member of DARK_PLAN_FLAGS or PREPIN_DARK_FLAGS, so
// EntitlementAuthority.computeOldPathAll's generic branch for it reduces to plain
// `entFlags.includes("flag.credit_limits")` — identical to what the NEW/one-rule path ALSO
// computes for this key (same underlying `flags` array, no courtesy branch on either side). Run
// through the generic algorithm unmodified, this key would NEVER show a diff, in either direction,
// regardless of catalog state — which would silently defeat the one thing design.md is explicit
// this report must protect: the credit-limit guard is real production behaviour TODAY, running
// unconditionally, because orders.service.ts's assertWithinCreditLimit does not consult the
// entitlement system at all yet (that wiring is later, gated on `can(flag.credit_limits)` only
// once `entitlements.mode=live`). So its CURRENT real-world effective value is unconditionally
// true — a fact about production code today, not something FEATURE_REGISTRY's data encodes — and
// treating it as literally "whatever the generic branch says" would understate today's true
// baseline exactly where the money guard is concerned.
//
// Scope of the deviation: applied ONLY when no active override exists for the key (an explicit
// admin GRANT/DENY on this key — however unlikely today, since nothing enforces it yet — still
// takes absolute priority, matching every real code path). This is the single highest-uncertainty
// judgment call in this whole mirror; flagged for independent review.
const ALWAYS_EFFECTIVE_TODAY = new Set(["flag.credit_limits"]);

// ─── old-path / new-path per-key resolvers ─────────────────────────────────────────────────────
//
// `ctx`:
//   overrides       Map<featureKey, "GRANT"|"DENY">  — this tenant's ACTIVE overrides only
//   activeAddonSet  Set<addonKey>                     — this tenant's ACTIVE TenantAddon keys
//   planKey         string                            — Entitlements.planKey (post plan-catalog resolution)
//   entFlags        string[]                          — Entitlements.flags (plan.featureFlags ∪ active-addon grantsFlags)

/**
 * Mirrors EntitlementAuthority.computeOldPathAll's per-key branch (today's four-layer answer),
 * plus the ALWAYS_EFFECTIVE_TODAY deviation documented above.
 */
function computeOldPathEffective(feature, ctx, env = process.env) {
  const override = ctx.overrides.get(feature.key);
  if (override === "GRANT") return true;
  if (override === "DENY") return false;

  if (ALWAYS_EFFECTIVE_TODAY.has(feature.key)) return true;

  const isAddonKeyed = feature.via === "RequireAddon" || feature.via === "guard";
  if (isAddonKeyed) {
    const active = ctx.activeAddonSet.has(feature.key);
    // addonGateState() only ever returns "dark" for a RequireAddon row (ADDON_GATE_REGISTRY is
    // derived from RequireAddon rows only) — a "guard" row like driver_payments always reads back
    // "enforced", regardless of its own gate.state field, because it was never in that projection.
    const courtesyState = feature.via === "RequireAddon" ? feature.state : "enforced";
    return active || (courtesyState === "dark" && !isAlwaysEnforcedPlan(ctx.planKey));
  }

  return allowsFlag(ctx.planKey, ctx.entFlags, feature.key, env);
}

/** Mirrors resolveOneKey's per-key branch (the one-rule answer), boolean-only (no source/detail —
 *  this report only needs effective true/false, never charged/term/sku). */
function computeNewPathEffective(feature, ctx) {
  const override = ctx.overrides.get(feature.key);
  if (override === "GRANT") return true;
  if (override === "DENY") return false;

  const isAddonKeyed = feature.via === "RequireAddon" || feature.via === "guard";
  if (isAddonKeyed) return ctx.activeAddonSet.has(feature.key);

  if (ctx.entFlags.includes(feature.key)) return true;
  return feature.defaultGranted === true;
}

module.exports = {
  FEATURE_REGISTRY_MIRROR,
  DARK_PLAN_FLAGS,
  PREPIN_DARK_FLAGS,
  ALWAYS_ENFORCED_PLAN_KEYS,
  ALWAYS_EFFECTIVE_TODAY,
  isPlanFlagEnforcementOn,
  isDarkFlag,
  allowsFlag,
  isAlwaysEnforcedPlan,
  PLAN_KEYS,
  LEGACY_PLAN_KEY_ALIASES,
  normalizePlanKey,
  findPlanDefinition,
  planKeyFromEnum,
  LEGACY_ADDON_KEY_TO_SKU,
  addonSkuCode,
  computeOldPathEffective,
  computeNewPathEffective,
};
