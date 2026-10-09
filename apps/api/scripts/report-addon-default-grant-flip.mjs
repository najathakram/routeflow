// READ-ONLY aggregate report — owner ruling 2026-09-28 / SA-540: `orders_inline_returns`
// becomes `defaultGranted: true` in `apps/api/src/billing/feature-registry.ts`. A tenant now
// holds the key with NO `TenantAddon` row when (a) it has no DENY override on
// `orders_inline_returns` and (b) its requirement set contains `flag.returns` — see
// `isDefaultGrantedAddonMirror` in `scripts/lib/feature-registry-mirror.cjs` (the JS twin of the
// real rule; read that file's header for the full mirror/source-of-truth contract).
//
// This report answers ONE question for the owner: how many tenants newly GAIN
// `orders_inline_returns` because of the default grant, broken down by plan key. It prints
// AGGREGATE COUNTS ONLY — no tenant id, slug, name, or email ever appears in its output.
//
// NEVER RUN FROM AN IMPLEMENTATION SESSION. The owner runs this on prod:
//
//   railway run --service postgres node apps/api/scripts/report-addon-default-grant-flip.mjs
//
// MIRROR, NOT SOURCE OF TRUTH (same convention as audit-tenant-entitlements.mjs and
// report-addon-gate-blast-radius.mjs): plan-key/catalog resolution here is a plain SQL/JS copy of
// `EntitlementsService.compute()` (apps/api/src/billing/entitlements.service.ts) and the
// default-grant rule is `isDefaultGrantedAddonMirror` from `scripts/lib/feature-registry-mirror.cjs`
// (imported, never re-derived). Any behavioural change to those real modules belongs there FIRST,
// ported here in the same PR.
//
// SAFETY (this script must never be able to modify a client database):
//   - `default_transaction_read_only = on` is set on the session before any other query runs, so
//     the server itself rejects a write even if one slipped past review.
//   - `statement_timeout` caps every query.
//   - No transaction is left open; the connection is closed in `finally`.
//   - Only SELECT queries appear below. No tenant id/slug/name/email is ever printed, hardcoded,
//     or included in `--json` output — every row this script prints is a count.
import { createRequire } from "module";
import { pathToFileURL } from "url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";

// Pure classification/aggregation lives in scripts/lib/addon-default-grant-flip-classify.cjs —
// CommonJS so the Jest spec can `require()` the exact same code this script runs, without
// needing --experimental-vm-modules to dynamic-`import()` an ESM file (see that file's header).
const require_ = createRequire(import.meta.url);
const { Client } = require_("pg");
const { planKeyFromEnum, findPlanDefinition, effectivePlanFlagsMirror, LEGACY_ADDON_KEY_TO_SKU } =
  require_("./lib/feature-registry-mirror.cjs");
const { TARGET_KEY, BUCKETS, classifyTenant, aggregate, payingOnLiteLine } = require_(
  "./lib/addon-default-grant-flip-classify.cjs",
);
// #2700 (SA-559a): the ONE paying predicate for scripts — required, never re-derived.
const { isPayingTenant } = require_("./lib/paying-tenant.cjs");

export { TARGET_KEY, BUCKETS, classifyTenant, aggregate, payingOnLiteLine };

function parseArgs(argv) {
  let json = false;
  for (const arg of argv) {
    if (arg === "--json") json = true;
  }
  return { json };
}

const { json } = parseArgs(process.argv.slice(2));

const q = async (client, sql, params) => (await client.query(sql, params)).rows;

async function loadCatalogVersion(client, id) {
  const [version] = await q(client, `SELECT id, version, status FROM "PlanVersion" WHERE id = $1`, [
    id,
  ]);
  if (!version) return null;
  const definitions = await q(
    client,
    `SELECT "planKey", "featureFlags" FROM "PlanDefinition" WHERE "planVersionId" = $1 ORDER BY "sortOrder" ASC`,
    [id],
  );
  const addonSkus = await q(
    client,
    `SELECT sku, "grantsFlags" FROM "AddonSku" WHERE "planVersionId" = $1 ORDER BY "sortOrder" ASC`,
    [id],
  );
  return { ...version, definitions, addonSkus };
}

/** Mirrors `PlanCatalogService.getPublishedVersion` — highest-version PUBLISHED row. */
async function loadPublishedVersion(client) {
  const [row] = await q(
    client,
    `SELECT id FROM "PlanVersion" WHERE status = 'PUBLISHED' ORDER BY version DESC LIMIT 1`,
  );
  if (!row) return null;
  return loadCatalogVersion(client, row.id);
}

/** Mirrors `addonSkuCode` (feature-registry-mirror.cjs re-exports the legacy bridge). */
function addonSkuCodeOf(row, legacyMap) {
  return row.sku ?? legacyMap[row.addonKey] ?? null;
}

async function main() {
  const databaseUrl = resolveReportDbUrl("report-addon-default-grant-flip");
  if (!databaseUrl) {
    // B768: the resolver above already printed why (it owns the env-var name); only say how to run.
    console.error(
      "report-addon-default-grant-flip: no database target — run via " +
        "`railway run --service postgres node apps/api/scripts/report-addon-default-grant-flip.mjs`",
    );
    process.exit(2);
    return;
  }

  const host = (() => {
    try {
      const u = new URL(databaseUrl);
      return `${u.host}/${u.pathname.replace(/^\//, "")}`;
    } catch {
      return "unparseable";
    }
  })();

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();

    // Hard read-only guarantee + query cap, before anything else runs.
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '45s'");

    if (!json) {
      console.log(`\n=== ADDON DEFAULT-GRANT FLIP — "${TARGET_KEY}" — ${host} ===`);
      console.log("    READ ONLY — implements owner ruling 2026-09-28 / SA-540");
      console.log("    counts only; no tenant id/slug/name/email is ever printed\n");
    }

    const publishedVersion = await loadPublishedVersion(client);
    if (!publishedVersion) {
      console.error("No PUBLISHED plan catalog version found — nothing to report.");
      process.exitCode = 1;
      return;
    }

    const tenants = await q(
      client,
      `SELECT t.id, t.plan, t.status, t.class, t."deletedAt", t."planVersionId",
              s."planKey" AS "subPlanKey",
              s."couponFull" AS "subCouponFull"
         FROM "Tenant" t
         LEFT JOIN "TenantSubscription" s ON s."tenantId" = t.id
        WHERE t."deletedAt" IS NULL`,
    );

    const activeAddonRows = await q(
      client,
      `SELECT "tenantId", "addonKey", sku FROM "TenantAddon" WHERE active = true`,
    );
    const activeAddonsByTenant = new Map();
    for (const row of activeAddonRows) {
      const list = activeAddonsByTenant.get(row.tenantId) ?? [];
      list.push(row);
      activeAddonsByTenant.set(row.tenantId, list);
    }

    const inactiveTargetRows = await q(
      client,
      `SELECT "tenantId" FROM "TenantAddon" WHERE active = false AND "addonKey" = $1`,
      [TARGET_KEY],
    );
    const inactiveTargetTenantIds = new Set(inactiveTargetRows.map((r) => r.tenantId));

    // Active overrides only: not revoked, and either no expiry or not yet expired — same
    // definition FeatureOverrideService.activeRows()/effectAt() use.
    const overrideRows = await q(
      client,
      `SELECT "tenantId", "featureKey", effect
         FROM "TenantFeatureOverride"
        WHERE "revokedAt" IS NULL AND ("expiresAt" IS NULL OR "expiresAt" > NOW())`,
    );
    const overridesByTenant = new Map();
    for (const row of overrideRows) {
      const map = overridesByTenant.get(row.tenantId) ?? new Map();
      map.set(row.featureKey, row.effect);
      overridesByTenant.set(row.tenantId, map);
    }

    const versionCache = new Map();
    async function getVersion(id) {
      if (!id) return publishedVersion;
      if (versionCache.has(id)) return versionCache.get(id) ?? publishedVersion;
      const v = await loadCatalogVersion(client, id);
      versionCache.set(id, v);
      return v ?? publishedVersion;
    }

    const classifiedRows = [];
    for (const tenant of tenants) {
      const planKeyRaw = tenant.subPlanKey ?? planKeyFromEnum(tenant.plan);
      const version = await getVersion(tenant.planVersionId);

      const exactDef = findPlanDefinition(version.definitions, planKeyRaw);
      const def =
        exactDef ??
        version.definitions.find((d) => d.planKey === "STARTER") ??
        version.definitions[0];
      const effectivePlanKey = def ? def.planKey : (planKeyRaw ?? "UNKNOWN");

      const activeAddons = activeAddonsByTenant.get(tenant.id) ?? [];
      const activeAddonSet = new Set(activeAddons.map((a) => a.addonKey));

      // #2700 (SA-559(3i)): flags gain forward, exactly as compute() — the LITE row moves
      // REQUIRES_UNMET → FLIPS_ON when a published catalog adds flag.returns to LITE.
      const flags = new Set(def ? effectivePlanFlagsMirror(def, version.id, publishedVersion) : []);
      const skuByCode = new Map((version.addonSkus ?? []).map((s) => [s.sku, s]));
      let publishedSkuByCode = null;
      for (const addon of activeAddons) {
        const code = addonSkuCodeOf(addon, LEGACY_ADDON_KEY_TO_SKU);
        if (!code) continue;
        let meta = skuByCode.get(code);
        if (!meta) {
          if (!publishedSkuByCode) {
            publishedSkuByCode =
              publishedVersion.id === version.id
                ? new Map()
                : new Map(publishedVersion.addonSkus.map((s) => [s.sku, s]));
          }
          meta = publishedSkuByCode.get(code);
        }
        if (!meta) continue;
        for (const flag of meta.grantsFlags) flags.add(flag);
      }

      const overrides = overridesByTenant.get(tenant.id) ?? new Map();
      const bucket = classifyTenant({
        hasActiveRow: activeAddonSet.has(TARGET_KEY),
        activeAddonSet,
        entFlags: [...flags],
        overrides,
      });

      classifiedRows.push({
        planKey: effectivePlanKey,
        bucket,
        hasInactiveRow: inactiveTargetTenantIds.has(tenant.id),
        // a tenant with no plan is never paying; otherwise the flag is passed raw (undefined THROWS, never coerced)
        paying:
          tenant.subPlanKey == null
            ? false
            : isPayingTenant(tenant, tenant.subPlanKey, tenant.subCouponFull),
      });
    }

    const result = aggregate(classifiedRows);

    if (json) {
      console.log(JSON.stringify({ key: TARGET_KEY, ...result }, null, 2));
      return;
    }

    console.log("## BY PLAN KEY\n");
    console.table(
      result.byPlan.map((r) => ({
        planKey: r.planKey,
        FLIPS_ON: r.FLIPS_ON,
        ALREADY_HELD: r.ALREADY_HELD,
        DENIED: r.DENIED,
        REQUIRES_UNMET: r.REQUIRES_UNMET,
        INACTIVE_ROW: r.INACTIVE_ROW,
        PAYING: r.PAYING,
        PAYING_FLIPS_ON: r.PAYING_FLIPS_ON,
        total: r.total,
      })),
    );

    console.log("\n## TOTALS\n");
    console.table([result.totals]);

    console.log(
      `\n${result.totals.FLIPS_ON} tenant(s) newly gain "${TARGET_KEY}" with no TenantAddon row once the default grant ships.\n`,
    );
    // SA-559a: the line the owner posts on #2554 before AND after the v13 publish (a count only).
    console.log(`${payingOnLiteLine(result)}\n`);
    console.log("=== END — session was read-only; nothing was modified ===\n");
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("addon-default-grant-flip report failed:", e.message);
    process.exitCode = 1;
  });
}
