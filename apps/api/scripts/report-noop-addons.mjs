/**
 * READ-ONLY report for SA-1099 §6 / WP5 (R23, owner Q4 2026-11-04): which BILLED self-serve add-on purchases
 * added nothing because the workspace already held every flag the SKU grants. The owner credits from this list;
 * nothing here (or in WP5) credits, refunds or edits anything.
 *
 * A row is a "no-op purchase" when ALL hold:
 *   - active, not a comp, and billed: it has a Stripe item, or a price above zero;
 *   - a SELF-SERVE SKU whose `grantsFlags` (from the workspace's own pinned catalog version, else the published
 *     one) is non-empty and which is not a capacity SKU (no meter key, no per-unit capacity);
 *   - EVERY flag it grants is held without it: carried by the workspace's plan (`PlanDefinition.featureFlags`),
 *     or a dark flag on a plan that is not always enforced (the courtesy allow), while the enforcement switch is
 *     off; and no active DENY override sits on that flag.
 * Each row says WHY per flag ("plan" or "courtesy"), so the owner can see whether the plan or the rollout switch made
 * the purchase empty.
 *
 * `--enforcement on|off` states what PLAN_FLAG_ENFORCEMENT is in production (default off). The sweep's first page
 * (`planFlagEnforcement`) reports it; a script on the postgres service cannot read the API's env. With `on`, no flag
 * is courtesy and only plan-carried flags count.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The fleet lead runs it under its `railway run` authorization
 * (warn-then-approve):
 *
 *   railway run --service postgres node apps/api/scripts/report-noop-addons.mjs [--enforcement on|off] [--json]
 *
 * Output is tenant UUIDs, row ids, SKU codes, flags and COUNTS only: no tenant name, slug, user id or price. Test
 * tenants (scripts/lib/test-tenants.cjs) are tagged TEST; everything else LIVE.
 *
 * `--self-test` runs the pure checks with no database and exits.
 *
 * SAFETY: `default_transaction_read_only = on` before any other query; `statement_timeout` and `lock_timeout` cap
 * every query; the connection is closed in `finally`; only SELECT appears below. No write script is called.
 */
import { createRequire } from "module";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);
const { Client } = require("pg");
const { isTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

/**
 * Mirrors of API constants. A .mjs cannot import the TS; report-noop-addons-script.spec.ts pins each one to its
 * source (SELF_SERVICE_ADDON_SKUS, LEGACY_ADDON_KEY_TO_SKU, DARK_PLAN_FLAGS + the pre-pin dark set,
 * ALWAYS_ENFORCED_PLAN_KEYS).
 */
export const SELF_SERVICE_ADDON_SKUS = ["CUSTOMER_PACK_100", "FORECASTING"];
export const LEGACY_ADDON_KEY_TO_SKU = {
  tobacco_dealer: "REGULATED_ITEMS",
  msrp: "MSRP",
  sales_agents: "SALES_AGENTS",
  ocr: "OCR_PACK_250",
};
export const DARK_PLAN_FLAGS = [
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
];
/** Dark whatever the switch says (plan-flag-policy.ts PREPIN_DARK_FLAGS). */
export const PREPIN_DARK_FLAGS = [
  "flag.estimates",
  "flag.recurring_invoices",
  "flag.credit_notes",
  "flag.suppliers",
  "flag.messaging",
];
export const ALWAYS_ENFORCED_PLAN_KEYS = ["LITE"];

/** planKeyFromEnum / normalizePlanKey in one: the enum names and the catalog names meet on the catalog name. */
export function normalizePlan(key) {
  switch (key) {
    case "TEAM":
      return "GROWTH";
    case "BUSINESS":
    case "PROFESSIONAL":
      return "SCALE";
    default:
      return key ?? "STARTER";
  }
}

/**
 * Why one flag is held WITHOUT the add-on: "plan" (the plan carries it), "courtesy" (a dark flag on a plan that is
 * not always enforced), or null (not held, or an active DENY rules it out).
 */
export function heldWithoutSku({ flag, planKey, planFlags, denied, enforcementOn }) {
  if (denied.has(flag)) return null;
  if (planFlags.includes(flag)) return "plan";
  const always = ALWAYS_ENFORCED_PLAN_KEYS.includes(planKey);
  const dark =
    PREPIN_DARK_FLAGS.includes(flag) || (DARK_PLAN_FLAGS.includes(flag) && !enforcementOn);
  return dark && !always ? "courtesy" : null;
}

/**
 * The verdict for one billed row: `{ noop: false }` or `{ noop: true, why: { flag: "plan" | "courtesy" } }`.
 * Capacity SKUs and an empty `grantsFlags` are never a no-op.
 */
export function classifyRow({ sku, planKey, planFlags, denied, enforcementOn }) {
  const flags = sku.grantsFlags ?? [];
  if (flags.length === 0 || sku.meteredKey != null || sku.capacityPerUnit != null)
    return { noop: false };
  const why = {};
  for (const flag of flags) {
    const held = heldWithoutSku({ flag, planKey, planFlags, denied, enforcementOn });
    if (!held) return { noop: false };
    why[flag] = held;
  }
  return { noop: true, why };
}

/** No-DB checks of the pure parts (`--self-test`). Throws on the first failure. */
export function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  const forecasting = { grantsFlags: ["flag.forecasting", "flag.analytics"] };
  const base = { planKey: "STARTER", planFlags: [], denied: new Set(), enforcementOn: false };
  eq(
    classifyRow({ ...base, sku: forecasting }),
    { noop: true, why: { "flag.forecasting": "courtesy", "flag.analytics": "courtesy" } },
    "starter, switch off: courtesy",
  );
  eq(
    classifyRow({ ...base, sku: forecasting, planFlags: ["flag.forecasting", "flag.analytics"] }),
    { noop: true, why: { "flag.forecasting": "plan", "flag.analytics": "plan" } },
    "plan carries both",
  );
  eq(classifyRow({ ...base, sku: forecasting, enforcementOn: true }), { noop: false }, "switch on");
  eq(
    classifyRow({ ...base, sku: forecasting, planKey: "LITE" }),
    { noop: false },
    "always enforced",
  );
  eq(
    classifyRow({ ...base, sku: forecasting, denied: new Set(["flag.analytics"]) }),
    { noop: false },
    "a DENY rules the flag out",
  );
  eq(
    classifyRow({ ...base, sku: { grantsFlags: ["flag.forecasting", "flag.msrp"] } }),
    { noop: false },
    "one flag still missing",
  );
  eq(classifyRow({ ...base, sku: { grantsFlags: [] } }), { noop: false }, "empty grantsFlags");
  eq(
    classifyRow({ ...base, sku: { grantsFlags: ["flag.forecasting"], capacityPerUnit: 100 } }),
    { noop: false },
    "capacity SKU",
  );
  eq(normalizePlan("TEAM"), "GROWTH", "TEAM maps to GROWTH");
  const s = summarize([
    { id: "r1", tenantId: "t1", slug: "x", sku: "FORECASTING", quantity: 1, why: { a: "plan" } },
    {
      id: "r2",
      tenantId: "t2",
      slug: "y",
      sku: "FORECASTING",
      quantity: 1,
      why: { a: "courtesy" },
    },
  ]);
  eq(s.total, 2, "total");
  eq(s.tenants, 2, "tenants");
  eq(s.bySku, { FORECASTING: 2 }, "by sku");
  if (JSON.stringify(s).includes('"x"') || JSON.stringify(s).includes('"y"'))
    throw new Error("summary leaked a slug");
  return "self-test ok";
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    console.log(selfTest());
    return;
  }
  const json = argv.includes("--json");
  const enfArg = argv.indexOf("--enforcement");
  const enfVal = enfArg >= 0 ? argv[enfArg + 1] : "off";
  if (enfVal !== "on" && enfVal !== "off") {
    console.error("report-noop-addons: --enforcement must be on or off");
    process.exit(2);
  }
  const enforcementOn = enfVal === "on";
  const databaseUrl = resolveReportDbUrl("report-noop-addons");
  if (!databaseUrl) process.exit(2);

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '45s'");
    await client.query("SET lock_timeout = '5s'");

    const legacyKeys = Object.keys(LEGACY_ADDON_KEY_TO_SKU);
    const legacySkus = legacyKeys.map((k) => LEGACY_ADDON_KEY_TO_SKU[k]);
    const billed = await client.query(
      `WITH legacy AS (SELECT * FROM unnest($1::text[], $2::text[]) AS m(key, sku)),
            published AS (
              SELECT id FROM "PlanVersion" WHERE status = 'PUBLISHED'
               ORDER BY "publishedAt" DESC NULLS LAST, version DESC LIMIT 1)
       SELECT a.id, a."tenantId", t.slug, a.quantity,
              COALESCE(a.sku, l.sku, a."addonKey") AS sku,
              COALESCE(s."planKey", t.plan::text) AS "planKey",
              COALESCE(s."planVersionId", t."planVersionId", (SELECT id FROM published)) AS "versionId"
         FROM "TenantAddon" a
         JOIN "Tenant" t ON t.id = a."tenantId"
         LEFT JOIN "TenantSubscription" s ON s."tenantId" = a."tenantId"
         LEFT JOIN legacy l ON l.key = a."addonKey"
        WHERE a.active = true
          AND a."isComp" = false
          AND (a."stripeItemId" IS NOT NULL OR COALESCE(a."priceSnapshot", 0) > 0)
          AND COALESCE(a.sku, l.sku, a."addonKey") = ANY($3::text[])
        ORDER BY a."tenantId", sku, a.id`,
      [legacyKeys, legacySkus, SELF_SERVICE_ADDON_SKUS],
    );
    const versions = [...new Set(billed.rows.map((r) => r.versionId).filter(Boolean))];
    const tenants = [...new Set(billed.rows.map((r) => r.tenantId))];
    const skus = await client.query(
      `SELECT "planVersionId" AS "versionId", sku, "grantsFlags", "meteredKey"::text AS "meteredKey",
              "capacityPerUnit"
         FROM "AddonSku" WHERE "planVersionId" = ANY($1::text[]) AND sku = ANY($2::text[])`,
      [versions, SELF_SERVICE_ADDON_SKUS],
    );
    const plans = await client.query(
      `SELECT "planVersionId" AS "versionId", "planKey", "featureFlags"
         FROM "PlanDefinition" WHERE "planVersionId" = ANY($1::text[])`,
      [versions],
    );
    const denies = await client.query(
      `SELECT "tenantId", "featureKey" FROM "TenantFeatureOverride"
        WHERE "tenantId" = ANY($1::text[]) AND effect = 'DENY' AND "revokedAt" IS NULL
          AND ("expiresAt" IS NULL OR "expiresAt" > now())`,
      [tenants],
    );

    const skuAt = new Map(skus.rows.map((r) => [`${r.versionId}|${r.sku}`, r]));
    const flagsAt = new Map(
      plans.rows.map((r) => [`${r.versionId}|${normalizePlan(r.planKey)}`, r.featureFlags ?? []]),
    );
    const deniedBy = new Map();
    for (const d of denies.rows) {
      if (!deniedBy.has(d.tenantId)) deniedBy.set(d.tenantId, new Set());
      deniedBy.get(d.tenantId).add(d.featureKey);
    }

    const noops = [];
    for (const r of billed.rows) {
      const sku = skuAt.get(`${r.versionId}|${r.sku}`);
      if (!sku) continue; // not in the workspace's catalog version: cannot judge, so not claimed
      const planKey = normalizePlan(r.planKey);
      const verdict = classifyRow({
        sku,
        planKey,
        planFlags: flagsAt.get(`${r.versionId}|${planKey}`) ?? [],
        denied: deniedBy.get(r.tenantId) ?? new Set(),
        enforcementOn,
      });
      if (verdict.noop) noops.push({ ...r, why: verdict.why });
    }

    const report = {
      enforcement: enfVal,
      live: summarize(noops.filter((r) => !isTestTenant(r.slug))),
      test: summarize(noops.filter((r) => isTestTenant(r.slug))),
    };
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`enforcement assumed ${enfVal}`);
      for (const block of ["live", "test"]) {
        const s = report[block];
        console.log(
          `${block.toUpperCase()}: ${s.total} no-op purchase(s) across ${s.tenants} tenant(s)`,
        );
        for (const d of s.detail)
          console.log(
            `  ${d.id}  tenant ${d.tenantId}  ${d.sku}  qty ${d.quantity}  ${Object.entries(d.why)
              .map(([f, w]) => `${f}:${w}`)
              .join(" ")}`,
          );
      }
    }
  } finally {
    await client.end().catch(() => {});
  }
}

/** Counts + one detail line per row. Ids and UUIDs only; the slug is used by the caller to split LIVE/TEST and never kept. */
export function summarize(rows) {
  const bySku = {};
  const detail = rows.map((r) => {
    bySku[r.sku] = (bySku[r.sku] ?? 0) + 1;
    return { id: r.id, tenantId: r.tenantId, sku: r.sku, quantity: r.quantity, why: r.why };
  });
  return {
    total: rows.length,
    tenants: new Set(rows.map((r) => r.tenantId)).size,
    bySku,
    detail,
  };
}

/**
 * Run only when invoked directly: importing this module (for `summarize` / `selfTest`) must never
 * start a report. Paths are compared after realpath, case-insensitively on Windows; when only the
 * file NAMES match it warns and runs anyway, because a silent exit 0 reads as "nothing found"
 * (the report-b673 pattern).
 */
export function isInvokedDirectly(entry = process.argv[1], self = fileURLToPath(import.meta.url)) {
  if (!entry) return false;
  const norm = (p) => {
    let r = p;
    try {
      r = realpathSync(p);
    } catch {
      // keep the path as given
    }
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  if (norm(entry) === norm(self)) return true;
  if (basename(entry).toLowerCase() === basename(self).toLowerCase()) {
    console.error(
      `report-noop-addons: warning: entry path ${entry} did not match ${self} exactly; running anyway.`,
    );
    return true;
  }
  return false;
}

if (isInvokedDirectly()) {
  main().catch((e) => {
    console.error(`report-noop-addons: ${e.message}`);
    process.exit(1);
  });
}
