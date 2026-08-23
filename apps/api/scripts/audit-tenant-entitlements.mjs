/**
 * READ-ONLY per-tenant entitlement audit — resolves flags/addons for every
 * live tenant (TRIAL/ACTIVE/READ_ONLY — `PlanFlagGuard` gates on resolved
 * flags alone and never consults tenant status, so neither may this audit)
 * exactly the way `EntitlementsService.compute()` does, and flags every gap
 * that would turn "ship dark" plan-flag enforcement into a live regression
 * once `PLAN_FLAG_ENFORCEMENT=on`.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The owner runs this later, once,
 * as a pre-flight check before flipping the kill switch:
 *
 *   railway run --service postgres node apps/api/scripts/audit-tenant-entitlements.mjs
 *
 * Why this exists: none of the 11 plan-catalog flags are enforced server-side
 * today (see `.claude/pipeline/plans/2026-08-23-enforce-plan-flags.md`), so a
 * tenant's PINNED catalog version can already lack a flag its UI freely uses —
 * nothing gated it, so nobody noticed. Turning on the guard/service kill
 * switch (`PLAN_FLAG_ENFORCEMENT`) makes those gaps user-visible for the
 * first time, with no code change of its own. This script is the pre-flight
 * check: it prints what every live tenant would resolve to today, then a
 * `## DISCREPANCIES` section calling out every tenant that would regress.
 *
 * MIRROR, NOT SOURCE OF TRUTH: the resolution logic below (plan-key
 * normalization, definition lookup, addon → flag union, the published-catalog
 * fallback for an addon SKU absent from a tenant's pinned version) is a plain
 * SQL/JS copy of `EntitlementsService.compute()`
 * (apps/api/src/billing/entitlements.service.ts) and the helpers in
 * `apps/api/src/billing/plan-catalog.constants.ts`. It exists as a copy only
 * because it runs standalone under plain `node` (invoked via `railway run`)
 * and cannot import the compiled Nest app. Any behavioural change to either
 * of those files belongs there FIRST, ported here in step — never the other
 * way around.
 *
 * SAFETY (this script must never be able to modify a client database):
 *   • `default_transaction_read_only = on` is set on the session, so the
 *     server itself rejects any INSERT/UPDATE/DELETE/DDL that might slip in.
 *   • `statement_timeout` caps every query.
 *   • No transaction is left open; the connection is closed in `finally`.
 *   • No tenant slugs are hardcoded anywhere in this file; nothing is ever
 *     written — every statement below is a SELECT.
 */
import { createRequire } from "module";
const { Client } = createRequire(import.meta.url)("pg");

/**
 * Resolve a connection string. Railway's `postgres` service publishes only its
 * credentials plus a TCP proxy; its DATABASE_URL (postgres.railway.internal) is
 * reachable only from inside Railway's network, so when running locally (or
 * via `railway run`, which injects the same variables) build the external
 * proxy URL from the individual parts instead. Credentials are never printed
 * — only host/database.
 */
function resolveUrl() {
  const direct = process.env.DATABASE_URL;
  if (direct && !direct.includes(".railway.internal")) return direct;
  const {
    POSTGRES_USER,
    POSTGRES_PASSWORD,
    POSTGRES_DB,
    RAILWAY_TCP_PROXY_DOMAIN,
    RAILWAY_TCP_PROXY_PORT,
  } = process.env;
  if (RAILWAY_TCP_PROXY_DOMAIN && POSTGRES_USER && POSTGRES_PASSWORD) {
    const db = POSTGRES_DB || "railway";
    const port = RAILWAY_TCP_PROXY_PORT || "5432";
    return `postgresql://${encodeURIComponent(POSTGRES_USER)}:${encodeURIComponent(POSTGRES_PASSWORD)}@${RAILWAY_TCP_PROXY_DOMAIN}:${port}/${db}`;
  }
  return direct || null;
}

const url = resolveUrl();
if (!url) {
  console.error(
    "No usable connection string — run via " +
      "`railway run --service postgres node apps/api/scripts/audit-tenant-entitlements.mjs`",
  );
  process.exit(1);
}

const host = (() => {
  try {
    const u = new URL(url);
    return `${u.host}/${u.pathname.replace(/^\//, "")}`;
  } catch {
    return "unparseable";
  }
})();

const client = new Client({ connectionString: url });
const q = async (sql, params) => (await client.query(sql, params)).rows;

// ─── plan-catalog.constants.ts mirror (keep in lock-step; see file header) ───

const PLAN_KEYS = ["STARTER", "GROWTH", "SCALE", "ENTERPRISE"];

/** Historical plan keys from catalog versions published before the rename. */
const LEGACY_PLAN_KEY_ALIASES = {
  TEAM: "GROWTH",
  BUSINESS: "SCALE",
  PROFESSIONAL: "SCALE",
};

/** Mirrors `normalizePlanKey` — map any historical or current plan key onto a current one. */
function normalizePlanKey(planKey) {
  if (!planKey) return null;
  if (PLAN_KEYS.includes(planKey)) return planKey;
  return Object.hasOwn(LEGACY_PLAN_KEY_ALIASES, planKey) ? LEGACY_PLAN_KEY_ALIASES[planKey] : null;
}

/** Mirrors `findPlanDefinition` — normalize both sides before comparing. */
function findPlanDefinition(definitions, planKey) {
  if (!planKey) return undefined;
  const want = normalizePlanKey(planKey) ?? planKey;
  return definitions.find((d) => (normalizePlanKey(d.planKey) ?? d.planKey) === want);
}

/** Mirrors `planKeyFromEnum` — legacy `Tenant.plan` enum → current planKey. */
function planKeyFromEnum(plan) {
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

/** Mirrors `LEGACY_ADDON_KEY_TO_SKU` — the pre-SKU free-text addonKey bridge. */
const LEGACY_ADDON_KEY_TO_SKU = {
  tobacco_dealer: "REGULATED_ITEMS",
  msrp: "MSRP",
};

/** Mirrors `addonSkuCode` — resolve an active TenantAddon row to its canonical SKU code. */
function addonSkuCode(row) {
  return row.sku ?? LEGACY_ADDON_KEY_TO_SKU[row.addonKey] ?? null;
}

// EVERY flag this rollout puts behind a gate: the seven `@RequirePlanFlag`
// keys (WP2) plus `flag.credit_limits`, checked in code by
// `OrdersService.assertWithinCreditLimit` (WP3). Keep in lock-step with the
// enforcement list in `plan-catalog.constants.ts`. A tenant missing ANY of
// these loses that surface the moment PLAN_FLAG_ENFORCEMENT=on, whatever
// catalog version it resolves against. `flag.msrp` is pre-existing (enforced
// before this rollout) and `flag.dispatch_live`/`flag.api_sso`/
// `flag.settlement` are deliberately never gated, so none is listed here.
const GATED_FLAGS = [
  "flag.analytics",
  "flag.ap_bills",
  "flag.import_integrations",
  "flag.forecasting",
  "flag.pricing_tiers",
  "flag.reports",
  "flag.returns",
  "flag.credit_limits",
];

// The three gated flags with a CONFIRMED v7→v8 grant-widening drift (plan
// §Known catalog drift): two widened DOWN a tier, and `returns` was newly
// granted at STARTER, in v8. A tenant pinned to an older version can lack one
// of these under its OWN pinned definition — invisible today because nothing
// gates it. Reported as an ANNOTATION on the loss table below, never as a
// filter: a tenant on the published catalog can be missing a gated flag
// simply because its tier is not granted it (v8 grants flag.analytics at
// GROWTH+, so a published-catalog STARTER tenant has none), and that
// regresses just as hard.
const DRIFT_FLAGS = ["flag.analytics", "flag.pricing_tiers", "flag.returns"];

// ─── catalog loading (mirror PlanCatalogService, plain SQL) ──────────────────

async function loadCatalogVersion(id) {
  const [version] = await q(`SELECT id, version, status FROM "PlanVersion" WHERE id = $1`, [id]);
  if (!version) return null;
  const definitions = await q(
    `SELECT "planKey", name, "featureFlags"
       FROM "PlanDefinition"
      WHERE "planVersionId" = $1
      ORDER BY "sortOrder" ASC`,
    [id],
  );
  const addonSkus = await q(
    `SELECT sku, "grantsFlags"
       FROM "AddonSku"
      WHERE "planVersionId" = $1
      ORDER BY "sortOrder" ASC`,
    [id],
  );
  return { ...version, definitions, addonSkus };
}

/** Mirrors `PlanCatalogService.getPublishedVersion` — highest-version PUBLISHED row. */
async function loadPublishedVersion() {
  const [row] = await q(
    `SELECT id FROM "PlanVersion" WHERE status = 'PUBLISHED' ORDER BY version DESC LIMIT 1`,
  );
  if (!row) return null;
  return loadCatalogVersion(row.id);
}

const versionCache = new Map(); // planVersionId -> version | null
async function getVersionById(id) {
  if (versionCache.has(id)) return versionCache.get(id);
  const v = await loadCatalogVersion(id);
  versionCache.set(id, v);
  return v;
}

/** Set once in `main()` before any tenant is resolved. */
let publishedVersion = null;

/** Mirrors `PlanCatalogService.getVersionForTenant` — pinned version if present, else published. */
async function getVersionForTenant(planVersionId) {
  const version = planVersionId
    ? ((await getVersionById(planVersionId)) ?? publishedVersion)
    : publishedVersion;
  if (!version) throw new Error("No published plan catalog exists.");
  return version;
}

// ─── EntitlementsService.compute() mirror (plain JS; no request-scoped cache needed here) ──

async function computeEntitlements(tenant, activeAddons) {
  const planKey = tenant.subPlanKey ?? planKeyFromEnum(tenant.plan);
  const version = await getVersionForTenant(tenant.planVersionId);

  // Resolve the definition for the tenant's planKey; fall back to STARTER (or
  // the first definition) if the pinned version has no matching row — same
  // conservative fallback as EntitlementsService.compute().
  const exactDef = findPlanDefinition(version.definitions, planKey);
  const def =
    exactDef ?? version.definitions.find((d) => d.planKey === "STARTER") ?? version.definitions[0];
  if (!def) throw new Error(`Plan catalog version ${version.id} has no plan definitions`);
  const effectivePlanKey = def.planKey;

  const skuByCode = new Map(version.addonSkus.map((s) => [s.sku, s]));

  const activeCodes = [];
  const flags = new Set(def.featureFlags);

  // An addon SKU introduced in a LATER catalog version than the tenant's
  // pinned one has no row in the pinned catalog — fall back to the published
  // catalog's SKU metadata (lazily, only when a pinned lookup actually
  // misses), same as EntitlementsService.compute().
  let publishedSkuByCode = null;
  for (const addon of activeAddons) {
    const code = addonSkuCode(addon);
    if (!code) continue;
    activeCodes.push(code);
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

  return {
    tenantId: tenant.id,
    slug: tenant.slug,
    status: tenant.status,
    planVersionId: version.id,
    planVersionNumber: version.version,
    isPublishedVersion: version.id === publishedVersion.id,
    planKey: effectivePlanKey,
    flags: [...flags],
    addons: [...new Set(activeCodes)],
  };
}

// ─── main ──────────────────────────────────────────────────────────────────

async function main() {
  await client.connect();

  // Hard read-only guarantee + query cap, before anything else runs.
  await client.query("SET default_transaction_read_only = on");
  await client.query("SET statement_timeout = '45s'");

  console.log(`\n=== TENANT ENTITLEMENT AUDIT — ${host} ===`);
  console.log(`    session is READ ONLY; no writes are possible\n`);

  publishedVersion = await loadPublishedVersion();
  if (!publishedVersion) {
    console.error("No PUBLISHED plan catalog version found — nothing to audit.");
    process.exitCode = 1;
    return;
  }
  console.log(`Published catalog: v${publishedVersion.version} (${publishedVersion.id})\n`);

  // TRIAL is the Tenant.status DEFAULT and a fully usable live state, and
  // READ_ONLY tenants still issue GETs — both are gated by PlanFlagGuard
  // exactly like ACTIVE ones. Anything this audit cannot see it cannot warn
  // about, so exclude only genuinely dead tenants.
  const tenants = await q(`
    SELECT t.id, t.slug, t.status, t.plan, t."planVersionId", s."planKey" AS "subPlanKey"
      FROM "Tenant" t
      LEFT JOIN "TenantSubscription" s ON s."tenantId" = t.id
     WHERE t.status NOT IN ('CANCELLED', 'SUSPENDED') AND t."deletedAt" IS NULL
     ORDER BY t.slug ASC
  `);

  const addonRows = await q(`
    SELECT "tenantId", "addonKey", sku, quantity
      FROM "TenantAddon"
     WHERE active = true
  `);
  const addonsByTenant = new Map();
  for (const row of addonRows) {
    const list = addonsByTenant.get(row.tenantId) ?? [];
    list.push(row);
    addonsByTenant.set(row.tenantId, list);
  }

  const rows = [];
  const errors = [];
  for (const tenant of tenants) {
    try {
      rows.push(await computeEntitlements(tenant, addonsByTenant.get(tenant.id) ?? []));
    } catch (e) {
      errors.push({ tenantId: tenant.id, slug: tenant.slug, error: e.message });
    }
  }

  console.log(
    `## TENANTS  (${rows.length} of ${tenants.length} resolved` +
      `${errors.length ? `, ${errors.length} FAILED to resolve` : ""})\n`,
  );
  console.table(
    rows.map((r) => ({
      tenantId: r.tenantId,
      slug: r.slug,
      status: r.status,
      planVersionId: r.planVersionId,
      planKey: r.planKey,
      flags: r.flags.join(", "),
      addons: r.addons.join(", "),
    })),
  );
  if (errors.length) {
    console.log("\n   ⚠ RESOLUTION ERRORS (excluded from the table above):");
    console.table(errors);
  }

  // ── DISCREPANCIES ──────────────────────────────────────────────────────────
  console.log("\n## DISCREPANCIES\n");

  // 1. Any tenant missing at least one GATED flag, computed from the gated-flag
  //    list itself and NOT from whether the tenant is pinned to an older
  //    catalog version. Pinning is one way to end up short a flag; sitting on a
  //    tier the PUBLISHED catalog does not grant it to is another (v8 grants
  //    flag.analytics/flag.pricing_tiers at GROWTH+ only, so every STARTER
  //    tenant on the published catalog resolves without them). These tenants
  //    use the gated surface freely today (nothing enforces the flag yet);
  //    once PLAN_FLAG_ENFORCEMENT=on they would start 403ing with no code
  //    change — the exact regression this audit exists to catch before the
  //    flip. `pinnedOlderVersion`/`missingDriftFlags` annotate each row.
  const flagLosses = rows
    .map((r) => ({ r, missing: GATED_FLAGS.filter((f) => !r.flags.includes(f)) }))
    .filter((x) => x.missing.length > 0);
  console.log(
    "1. TENANTS THAT WOULD NEWLY LOSE A GATED SURFACE once PLAN_FLAG_ENFORCEMENT=on\n" +
      `   (missing any of: ${GATED_FLAGS.join(", ")})`,
  );
  if (flagLosses.length === 0) {
    console.log("   (none)\n");
  } else {
    console.table(
      flagLosses.map(({ r, missing }) => ({
        tenantId: r.tenantId,
        slug: r.slug,
        status: r.status,
        planVersionId: r.planVersionId,
        planVersion: r.planVersionNumber,
        pinnedOlderVersion: r.isPublishedVersion ? "" : "YES",
        planKey: r.planKey,
        missingFlags: missing.join(", "),
        missingDriftFlags: DRIFT_FLAGS.filter((f) => missing.includes(f)).join(", "),
      })),
    );
    console.log("");
  }

  // 2. Any tenant resolving zero flags at all — almost certainly a catalog or
  //    subscription data problem (e.g. an unmatched planKey silently falling
  //    back to a definition with no featureFlags), worth investigating on its
  //    own regardless of which gates are on.
  const zeroFlagTenants = rows.filter((r) => r.flags.length === 0);
  console.log("2. TENANTS RESOLVING ZERO FLAGS");
  if (zeroFlagTenants.length === 0) {
    console.log("   (none)\n");
  } else {
    console.table(
      zeroFlagTenants.map((r) => ({
        tenantId: r.tenantId,
        slug: r.slug,
        planVersionId: r.planVersionId,
        planKey: r.planKey,
      })),
    );
    console.log("");
  }

  console.log("=== END — session was read-only; nothing was modified ===\n");
}

main()
  .catch((e) => {
    console.error("audit failed:", e.message);
    process.exitCode = 1;
  })
  .finally(() => client.end());
