// PR-0b "zero-loss report" — plain SQL/JS mirror of the feature-grants v2 resolution logic.
//
// MIRROR, NOT SOURCE OF TRUTH (same convention as apps/api/scripts/audit-tenant-entitlements.mjs's
// own header). It exists as a copy only because apps/api/scripts/publish-and-repin.mjs runs
// standalone under plain `node` (invoked via `railway run`) and cannot import the compiled Nest
// app. Any behavioural change to the files below belongs there FIRST, ported here in the SAME PR:
//   - apps/api/src/billing/feature-registry.ts           (FEATURE_REGISTRY — key/gate.via/gate.state/
//                                                          defaultGranted/billing.skus only;
//                                                          requires/conflicts/config are NOT
//                                                          mirrored — nothing here consults them.
//                                                          billing.skus IS mirrored (added 2026-09-19,
//                                                          N1) but ONLY for the apply-time expiry/
//                                                          reporting decision — see FEATURE_REGISTRY_MIRROR's
//                                                          own doc comment below; it never affects
//                                                          the old/new effective boolean itself)
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
// Per key: [key, via, state, defaultGranted, billingSkus].
//   via   — FeatureGateVia: "RequireAddon" | "RequirePlanFlag" | "guard" | "service" | "none"
//   state — the registry row's OWN gate.state ("dark"|"enforced"|"none"), kept verbatim for every
//           row for fidelity/debugging even though only a "RequireAddon" row's state is ever
//           consulted (see addonGateStateMirror below — ADDON_GATE_REGISTRY, and therefore
//           addonGateState(), is derived from RequireAddon rows ONLY; a "guard" row like
//           driver_payments always reads back "enforced" regardless of what its own state field
//           says, because it was never in that projection to begin with).
//   defaultGranted — FeatureDef.defaultGranted; consulted ONLY by the new/one-rule path
//           (computeOldPathAll has no defaultGranted fallback at all — see its own source).
//   billingSkus — FeatureDef.billing.skus, verbatim. Added 2026-09-19 (N1): the ORIGINAL version
//           of this file deliberately did NOT mirror billing.skus ("they don't change the
//           effective boolean") — true for the pure old/new comparison, but no longer true once
//           the APPLY-time WRITE decision needs it: a non-expiring grandfather grant on a key that
//           carries a real, self-service billing SKU (flag.analytics/flag.forecasting →
//           FORECASTING; addon.buyer_portal → BUYER_PORTAL) permanently gives away billed
//           functionality with no operator signal — the same class of harm the
//           addon-gate-courtesy exclusion exists to prevent, just through a different gate shape
//           (RequirePlanFlag+dark rather than RequireAddon+dark). Owner ruling 2026-09-19: such
//           grants are NOT excluded from --apply (unlike addon-gate-courtesy) but are time-boxed
//           to 90 days instead of permanent — see applyGrants() in publish-and-repin.mjs. Never
//           consulted by computeOldPathEffective/computeNewPathEffective — only by the apply-time
//           expiry/reporting logic in publish-and-repin.mjs.
//
// 35 entries, transcribed 2026-09-19 from FEATURE_REGISTRY at origin/master 27d80c21.
const FEATURE_REGISTRY_MIRROR = [
  ["ocr", "RequireAddon", "dark", false, ["OCR_PACK_250"]],
  ["tobacco_dealer", "RequireAddon", "enforced", false, ["REGULATED_ITEMS"]],
  ["recurring_routes", "RequireAddon", "enforced", false, []],
  ["order_delivery", "RequireAddon", "enforced", false, []],
  ["crm_gohighlevel", "RequireAddon", "dark", false, []],
  ["email.connected_mailbox", "RequireAddon", "dark", false, []],
  ["developer_mode", "RequireAddon", "enforced", false, []],
  ["driver_payments", "guard", "enforced", false, []],
  ["orders_inline_returns", "RequireAddon", "enforced", false, []],
  ["flag.msrp", "RequirePlanFlag", "enforced", false, ["MSRP"]],
  ["flag.sales_agents", "RequirePlanFlag", "enforced", false, ["SALES_AGENTS"]],
  ["flag.analytics", "RequirePlanFlag", "dark", false, ["FORECASTING"]],
  ["flag.forecasting", "RequirePlanFlag", "dark", false, ["FORECASTING"]],
  ["flag.reports", "RequirePlanFlag", "dark", false, []],
  ["flag.returns", "RequirePlanFlag", "dark", false, []],
  ["flag.ap_bills", "RequirePlanFlag", "dark", false, []],
  ["flag.pricing_tiers", "RequirePlanFlag", "dark", false, []],
  ["flag.import_integrations", "RequirePlanFlag", "dark", false, []],
  ["flag.estimates", "RequirePlanFlag", "dark", false, []],
  ["flag.recurring_invoices", "RequirePlanFlag", "dark", false, []],
  ["flag.credit_notes", "RequirePlanFlag", "dark", false, []],
  ["flag.suppliers", "RequirePlanFlag", "dark", false, []],
  ["flag.messaging", "RequirePlanFlag", "dark", false, []],
  ["addon.buyer_portal", "RequirePlanFlag", "dark", false, ["BUYER_PORTAL"]],
  ["flag.credit_limits", "service", "dark", false, []],
  ["flag.dispatch_live", "none", "none", false, []],
  ["flag.settlement", "none", "none", false, []],
  ["flag.api_sso", "none", "none", false, []],
  ["limit_seats", "none", "none", false, ["SEAT_EXTRA"]],
  ["limit_routes", "none", "none", false, ["ROUTE_EXTRA"]],
  ["limit_customers", "none", "none", false, ["CUSTOMER_PACK_100"]],
  ["metered_scans", "none", "none", false, []],
  ["metered_msgs", "none", "none", false, ["MSG_BUNDLE_500"]],
  ["catalog_varieties", "none", "none", true, []],
  ["routes_dispatch", "none", "none", true, []],
].map(([key, via, state, defaultGranted, billingSkus]) => ({
  key,
  via,
  state,
  defaultGranted,
  billingSkus,
}));

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
// CORRECTED after independent review (2026-09-19): the first version of this comment cited only
// design.md's prose and got the mechanism wrong. The REAL code —
// apps/api/src/orders/orders.service.ts's private isCreditLimitCheckEnabled() — is:
//   if ((process.env.PLAN_FLAG_ENFORCEMENT ?? "off") !== "on") return true;   // ALWAYS runs
//   ...
//   return await this.entitlements.hasFlag(tenantId, "flag.credit_limits");  // gated when "on"
// So `flag.credit_limits` is NOT unconditionally true — it is true unconditionally ONLY while
// PLAN_FLAG_ENFORCEMENT is off (today's real, current value — see
// project_entitlements_one_rule_2026-09-17.md: "Mitigated 06:11Z by deleting the env var... stays
// OFF (not re-enabled)"). While off, `entFlags.includes(key)`/`isDarkFlag(key)` never matter,
// because isCreditLimitCheckEnabled() returns before consulting entitlements at all — it is
// EXACTLY the case that needs a deviation, since `flag.credit_limits` is gate.via "service", is
// NOT a member of DARK_PLAN_FLAGS or PREPIN_DARK_FLAGS, and the generic branch
// (`allowsFlag`/`isDarkFlag`) would otherwise reduce to plain `entFlags.includes(key)` — identical
// to what the NEW/one-rule path also computes, so a diff would never surface for this key at all,
// silently defeating the one thing design.md is explicit this report must protect ("zero tenants
// lose the money guard"). While PLAN_FLAG_ENFORCEMENT is on, this key is NOT special — it behaves
// exactly like the generic branch (which is why `isDarkFlag`/env are threaded through here too).
//
// Scope, CORRECTED AGAIN after independent re-review (N3, 2026-09-19): the first fix pass had this
// checked AFTER the override lookup, on the theory that "an explicit admin override should always
// win". That is backwards for this ONE key: the real isCreditLimitCheckEnabled() (above) returns
// BEFORE ever consulting entitlements/overrides at all while enforcement is off — so a DENY
// override on flag.credit_limits has ZERO EFFECT on production today, and old-path is still
// unconditionally true regardless of it. Checked before the override lookup now (see
// computeOldPathEffective), so a DENY on this one key can never silently hide a real, unreported
// loss of the money guard again. Every OTHER key is unaffected — this Set has exactly one member.
const ALWAYS_EFFECTIVE_TODAY = new Set(["flag.credit_limits"]);

/** For a LOSS row (old=true, new=false), the mechanism that explains WHY the legacy path is
 *  true — computed structurally from `feature`, not re-derived per-tenant, because a loss can
 *  only arise from exactly one of these three shapes given computeOldPathEffective's own
 *  branching (an addon-keyed row can only diverge via the addon-gate courtesy allow; a flag/none/
 *  service-keyed row only via the plan-flag courtesy allow or the credit-limit toggle above).
 *  Consumed by publish-and-repin.mjs to keep "addon-gate-courtesy" losses (dark, not-yet-billed
 *  or not-yet-launched add-ons — design.md: "addon-gate-registry ... left alone, not an
 *  entitlement source") out of --apply's default write set: granting those to every tenant would
 *  permanently defeat their own, separate, still-in-progress rollout process. */
function lossMechanism(feature) {
  const isAddonKeyed = feature.via === "RequireAddon" || feature.via === "guard";
  if (isAddonKeyed) return "addon-gate-courtesy";
  if (ALWAYS_EFFECTIVE_TODAY.has(feature.key)) return "credit-limit-service-toggle";
  return "plan-flag-courtesy";
}

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
  // Checked BEFORE the override lookup (N3 fix, 2026-09-19) — see ALWAYS_EFFECTIVE_TODAY's own
  // doc comment: the real isCreditLimitCheckEnabled() returns unconditionally true, without ever
  // consulting overrides, while enforcement is off. Every other key is unaffected (the Set has
  // exactly one member), so overrides still decide everything else first, as before.
  if (ALWAYS_EFFECTIVE_TODAY.has(feature.key) && !isPlanFlagEnforcementOn(env)) return true;

  const override = ctx.overrides.get(feature.key);
  if (override === "GRANT") return true;
  if (override === "DENY") return false;

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
  lossMechanism,
};
