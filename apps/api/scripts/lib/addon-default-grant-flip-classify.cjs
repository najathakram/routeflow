"use strict";

// Pure classification/aggregation for report-addon-default-grant-flip.mjs (SA-540). CommonJS so
// both the .mjs report script (via createRequire) and its Jest spec (via plain require, since
// Jest's ts-jest/CJS transform cannot dynamic-`import()` an ESM file without
// --experimental-vm-modules) load the exact same code — no second copy to drift.
//
// isDefaultGrantedAddonMirror (feature-registry-mirror.cjs) is the JS twin of the real rule;
// this file only decides which of the four report buckets a tenant falls into and rolls counts
// up by plan key. No DB, no I/O, no tenant id/slug/name ever appears here.

const {
  FEATURE_REGISTRY_MIRROR,
  isDefaultGrantedAddonMirror,
} = require("./feature-registry-mirror.cjs");

const TARGET_KEY = "orders_inline_returns";

const TARGET_FEATURE = FEATURE_REGISTRY_MIRROR.find((f) => f.key === TARGET_KEY);
if (!TARGET_FEATURE) {
  // Fails at require time, before any DB connection is attempted — the mirror and this report
  // must never drift apart on which key exists.
  throw new Error(`feature-registry-mirror.cjs has no entry for "${TARGET_KEY}"`);
}

const BUCKETS = ["FLIPS_ON", "ALREADY_HELD", "DENIED", "REQUIRES_UNMET"];

/**
 * Pure classification — no DB, no I/O. Decides exactly one of the four buckets for one tenant's
 * relationship to `orders_inline_returns`, mirroring the real precedence order
 * (`computeOldPathEffective`/`computeNewPathEffective` in feature-registry-mirror.cjs): an
 * override on the key itself decides outright before anything else is consulted, then an active
 * `TenantAddon` row, then the default-grant requirement set.
 *
 * @param {object} ctx
 * @param {boolean} ctx.hasActiveRow - tenant holds an active TenantAddon row for the key.
 * @param {Set<string>} ctx.activeAddonSet - this tenant's active TenantAddon `addonKey`s.
 * @param {string[]} ctx.entFlags - this tenant's resolved Entitlements.flags.
 * @param {Map<string,"GRANT"|"DENY">} ctx.overrides - this tenant's ACTIVE feature overrides.
 * @returns {"FLIPS_ON"|"ALREADY_HELD"|"DENIED"|"REQUIRES_UNMET"}
 */
function classifyTenant(ctx) {
  const keyOverride = ctx.overrides.get(TARGET_KEY);
  if (keyOverride === "DENY") return "DENIED";
  if (keyOverride === "GRANT" || ctx.hasActiveRow) return "ALREADY_HELD";

  const requirementMet = isDefaultGrantedAddonMirror(
    TARGET_FEATURE,
    ctx.activeAddonSet,
    ctx.entFlags,
    ctx.overrides,
  );
  return requirementMet ? "FLIPS_ON" : "REQUIRES_UNMET";
}

/**
 * Pure aggregation — no DB, no I/O. `rows` is one entry per tenant:
 * `{ planKey: string, bucket: BUCKETS[number], hasInactiveRow: boolean, paying?: boolean }`.
 * Returns counts only — never a tenant id/slug/name. #2700 (SA-559a): `PAYING` counts the row's
 * paying tenants (scripts/lib/paying-tenant.cjs `isPayingTenant`, decided by the caller) and
 * `PAYING_FLIPS_ON` those of them in FLIPS_ON — the owner's "paying tenants on LITE: n" line,
 * before and after a publish.
 */
function aggregate(rows) {
  const emptyPlanRow = () => ({
    FLIPS_ON: 0,
    ALREADY_HELD: 0,
    DENIED: 0,
    REQUIRES_UNMET: 0,
    INACTIVE_ROW: 0,
    PAYING: 0,
    PAYING_FLIPS_ON: 0,
    total: 0,
  });

  const byPlan = new Map(); // planKey -> counts row
  const totals = emptyPlanRow();

  for (const row of rows) {
    const plan = row.planKey ?? "UNKNOWN";
    if (!byPlan.has(plan)) byPlan.set(plan, emptyPlanRow());
    const planRow = byPlan.get(plan);

    planRow[row.bucket] += 1;
    planRow.total += 1;
    totals[row.bucket] += 1;
    totals.total += 1;

    if (row.paying) {
      planRow.PAYING += 1;
      totals.PAYING += 1;
      if (row.bucket === "FLIPS_ON") {
        planRow.PAYING_FLIPS_ON += 1;
        totals.PAYING_FLIPS_ON += 1;
      }
    }

    if (row.hasInactiveRow) {
      planRow.INACTIVE_ROW += 1;
      totals.INACTIVE_ROW += 1;
    }
  }

  const planKeys = [...byPlan.keys()].sort();
  return {
    byPlan: planKeys.map((planKey) => ({ planKey, ...byPlan.get(planKey) })),
    totals,
  };
}

/** #2700 (SA-559a): the owner's one-line LITE paying count, from an `aggregate` result. */
function payingOnLiteLine(result) {
  const lite = result.byPlan.find((r) => r.planKey === "LITE");
  const n = lite ? lite.PAYING : 0;
  const flipped = lite ? lite.PAYING_FLIPS_ON : 0;
  return `paying tenants on LITE: ${n} (of which FLIPS_ON: ${flipped})`;
}

module.exports = {
  TARGET_KEY,
  payingOnLiteLine,
  BUCKETS,
  classifyTenant,
  aggregate,
};
