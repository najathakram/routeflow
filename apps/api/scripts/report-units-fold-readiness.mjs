/**
 * READ-ONLY census (SA-984 section 2 / D4 and SA-983 C1): is every tenant ready for the units fold-in (the three
 * flag.units_* keys on for everyone at D5)? One block per tenant id, all tenants, counts only.
 *
 *   C-1  ProductUnit rows: total / on products with unitsPerBox null or <= 1 / with factorToBase = 1
 *   C-2  products with unitsPerBox null, 0 or 1; of the ACTIVE ones, how many propose-pack-sizes rates HIGH / MEDIUM
 *   C-3  the U-6 plan counts (tenant-units-plan.cjs planTenantUnits, the backfill's own planner, never re-derived)
 *   C-4  odd tiers: Customer.pricingTier / CustomerPrice.pricingTier values that isOddTier flags (compiled dist)
 *   C-5  CustomerUnitPrice rows
 *   C-6  unit lines in flight: open orders, DRAFT invoices and DRAFT estimates with a line carrying a unitLabel
 *   C-7  tier copies: products whose priceTier2..5 equal Retail (pricePerUnit), and how many tier values
 *   C-8  holders: flag.units_v1 / flag.units_prices_v2 / flag.units_settings_v1, held how (override, plan)
 *   SA983-C1  live ProductBarcode rows that planBarcodeRows (compiled dist) would not produce for the product
 *
 * STOP lines (printed per tenant, also `stops` in --json). Any STOP comes back to the SA before D5:
 *   C-1 or C-6 above 0 on a tenant that does not hold flag.units_v1; C-5 above 0 on a tenant that does not hold
 *   flag.units_prices_v2; C-3 unlinkedOverflow above 0; C-4 above 0; SA983-C1 above 0.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The owner / lead runs it (OP-13), in two steps (the live-target guard):
 *   npm run build -w apps/api                     (once: C-4 and SA983-C1 import the compiled predicates from dist/)
 *   railway run --service postgres node apps/api/scripts/report-units-fold-readiness.mjs
 *   railway run --service postgres node apps/api/scripts/report-units-fold-readiness.mjs --target-host=<host it printed> [--json] [--tenant ID]
 *   node apps/api/scripts/report-units-fold-readiness.mjs --self-test      (no database, no dist)
 * Keep the output local (local-assets); it is tenant ids and counts, but never commit it.
 *
 * SAFETY: the SA-839 report pattern. Prints the DB host and refuses BEFORE connecting unless --target-host equals it
 * (exit 64 missing, 65 mismatch); the first statement is the read-only session setting, then BEGIN TRANSACTION READ
 * ONLY, aborts unless transaction_read_only is on, ends in ROLLBACK; refuses --apply/--fix/--repair (exit 2). Exit 2 as
 * well when dist/ is missing or stale. The output is tenant ids, the protected flag and counts: no slug, tenant or
 * customer name, product, or document number leaves this script. A STOP is a finding, not a failure: the exit stays 0.
 */
import { createRequire } from "module";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
import { classify } from "./lib/pack-size-classifier.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("pg");
const g = require("./lib/report-839-regulated-void-residue.cjs");
const { protectedTenantIds, refuseRetiredFlags } = require("./lib/live-target-guard.cjs");
const { loadProtectedSlugs } = require("./lib/protected-slugs.cjs");
const { planTenantUnits } = require("./lib/tenant-units-plan.cjs");

const NAME = "report-units-fold-readiness";
const HERE = dirname(fileURLToPath(import.meta.url));

export const KEYS = Object.freeze({
  unitsV1: "flag.units_v1",
  unitsPricesV2: "flag.units_prices_v2",
  unitsSettingsV1: "flag.units_settings_v1",
});
const KEY_FIELDS = Object.entries(KEYS);

// ─── SQL (SELECT only). $1 = tenant id or NULL for all tenants. ───────────────────────────────────

const Q = {
  tenants: `SELECT t.id AS "tenantId" FROM "Tenant" t WHERE ($1::text IS NULL OR t.id = $1::text) ORDER BY t.id`,
  c1: `
  SELECT pu."tenantId" AS "tenantId", count(*)::int AS total,
         count(*) FILTER (WHERE p."unitsPerBox" IS NULL OR p."unitsPerBox" <= 1)::int AS on_no_pack,
         count(*) FILTER (WHERE pu."factorToBase" = 1)::int AS factor_one
    FROM "ProductUnit" pu JOIN "Product" p ON p.id = pu."productId"
   WHERE ($1::text IS NULL OR pu."tenantId" = $1::text)
   GROUP BY pu."tenantId"`,
  c2Count: `
  SELECT p."tenantId" AS "tenantId", count(*)::int AS n
    FROM "Product" p
   WHERE (p."unitsPerBox" IS NULL OR p."unitsPerBox" <= 1) AND ($1::text IS NULL OR p."tenantId" = $1::text)
   GROUP BY p."tenantId"`,
  // propose-pack-sizes.mjs's own population: ACTIVE products without a pack size. Rows are classified in node.
  c2Rows: `
  SELECT p.name AS name, p.unit AS unit, p."unitSku" AS "unitSku"
    FROM "Product" p
   WHERE p."tenantId" = $1 AND p."isActive" = true AND (p."unitsPerBox" IS NULL OR p."unitsPerBox" <= 1)`,
  planProductUnits: `
  SELECT id, "productId", label, "tenantUnitId", "factorToBase", "parentUnitId", "perParent"
    FROM "ProductUnit" WHERE "tenantId" = $1`,
  planProducts: `SELECT id, unit, "unitsPerBox" FROM "Product" WHERE "tenantId" = $1`,
  planTenantUnits: `SELECT id, "nameKey", name, "archivedAt" FROM "TenantUnit" WHERE "tenantId" = $1`,
  // Candidates are the DISTINCT tier values; the isOddTier predicate (not SQL) decides which are odd.
  c4Customer: `
  SELECT c."tenantId" AS "tenantId", c."pricingTier" AS tier, count(*)::int AS n
    FROM "Customer" c
   WHERE ($1::text IS NULL OR c."tenantId" = $1::text)
   GROUP BY c."tenantId", c."pricingTier"`,
  c4CustomerPrice: `
  SELECT COALESCE(cp."tenantId", c."tenantId") AS "tenantId", cp."pricingTier" AS tier, count(*)::int AS n
    FROM "CustomerPrice" cp JOIN "Customer" c ON c.id = cp."customerId"
   WHERE cp."pricingTier" IS NOT NULL AND ($1::text IS NULL OR COALESCE(cp."tenantId", c."tenantId") = $1::text)
   GROUP BY COALESCE(cp."tenantId", c."tenantId"), cp."pricingTier"`,
  c5: `
  SELECT "tenantId", count(*)::int AS n FROM "CustomerUnitPrice"
   WHERE ($1::text IS NULL OR "tenantId" = $1::text) GROUP BY "tenantId"`,
  // "Open" = not terminal: an order is terminal at DELIVERED / CANCELLED; invoices and estimates count only as DRAFT.
  c6Orders: `
  SELECT o."tenantId" AS "tenantId", count(*)::int AS n
    FROM "Order" o
   WHERE o.status::text NOT IN ('DELIVERED', 'CANCELLED') AND ($1::text IS NULL OR o."tenantId" = $1::text)
     AND EXISTS (SELECT 1 FROM "OrderItem" i WHERE i."orderId" = o.id AND btrim(i."unitLabel") <> '')
   GROUP BY o."tenantId"`,
  c6Invoices: `
  SELECT v."tenantId" AS "tenantId", count(*)::int AS n
    FROM "Invoice" v
   WHERE v.status::text = 'DRAFT' AND ($1::text IS NULL OR v."tenantId" = $1::text)
     AND EXISTS (SELECT 1 FROM "InvoiceItem" i WHERE i."invoiceId" = v.id AND btrim(i."unitLabel") <> '')
   GROUP BY v."tenantId"`,
  c6Estimates: `
  SELECT e."tenantId" AS "tenantId", count(*)::int AS n
    FROM "Estimate" e
   WHERE e.status::text = 'DRAFT' AND ($1::text IS NULL OR e."tenantId" = $1::text)
     AND EXISTS (SELECT 1 FROM "EstimateItem" i WHERE i."estimateId" = e.id AND btrim(i."unitLabel") <> '')
   GROUP BY e."tenantId"`,
  // A tier value of 0 is Auto and Retail 0 is unpriced: neither is a copy.
  c7: `
  SELECT "tenantId", count(*) FILTER (WHERE copies > 0)::int AS products, COALESCE(sum(copies), 0)::int AS tier_values
    FROM (
      SELECT p."tenantId" AS "tenantId",
             (p."priceTier2" = p."pricePerUnit")::int + (p."priceTier3" = p."pricePerUnit")::int +
             (p."priceTier4" = p."pricePerUnit")::int + (p."priceTier5" = p."pricePerUnit")::int AS copies
        FROM "Product" p
       WHERE p."pricePerUnit" > 0 AND ($1::text IS NULL OR p."tenantId" = $1::text)
    ) s
   GROUP BY "tenantId"`,
  overrides: `
  SELECT o."tenantId" AS "tenantId", o."featureKey" AS "featureKey", o.effect::text AS effect
    FROM "TenantFeatureOverride" o
   WHERE o."featureKey" = ANY($2::text[]) AND ($1::text IS NULL OR o."tenantId" = $1::text)
     AND o."revokedAt" IS NULL AND (o."expiresAt" IS NULL OR o."expiresAt" > (now() AT TIME ZONE 'UTC'))`,
  planFlags: `
  SELECT s."tenantId" AS "tenantId", pd."featureFlags" AS flags
    FROM "TenantSubscription" s
    JOIN "PlanDefinition" pd ON pd."planVersionId" = s."planVersionId" AND pd."planKey" = s."planKey"
   WHERE ($1::text IS NULL OR s."tenantId" = $1::text)`,
  barcodeRows: `
  SELECT b."productId" AS "productId", b.code AS code, b.level::text AS level, b.origin::text AS origin,
         b."copiedFromLevel"::text AS "copiedFromLevel", b."primaryFor"::text AS "primaryFor",
         p.barcode AS barcode, p."unitsPerBox" AS "unitsPerBox"
    FROM "ProductBarcode" b JOIN "Product" p ON p.id = b."productId"
   WHERE b."tenantId" = $1 AND b.code IS NOT NULL`,
};

// ─── arguments ────────────────────────────────────────────────────────────────────────────────────

const ARGS_KNOWN = new Set(["--json", "--tenant", "--self-test"]);
const TENANT_ID_SHAPE = /^[A-Za-z0-9_-]{8,64}$/;

export function checkArgs(argv) {
  const hit = g.WRITE_FLAGS.find((f) => argv.includes(f));
  if (hit)
    return {
      ok: false,
      message: `refusing ${hit}: this report is read-only and has no write mode`,
    };
  const hostFlag = argv.filter((a) => a.startsWith("--target-host="));
  if (hostFlag.length > 1) return { ok: false, message: "--target-host given more than once" };
  const tenantAt = argv.indexOf("--tenant");
  for (const [i, a] of argv.entries()) {
    if (a.startsWith("--target-host=")) continue;
    if (a.startsWith("--") ? !ARGS_KNOWN.has(a) : argv[i - 1] !== "--tenant")
      return { ok: false, message: `unexpected argument ${a}` };
  }
  const tenant = tenantAt >= 0 ? argv[tenantAt + 1] : null;
  if (tenantAt >= 0 && (!tenant || !TENANT_ID_SHAPE.test(tenant)))
    return { ok: false, message: "--tenant needs a tenant id" };
  return {
    ok: true,
    json: argv.includes("--json"),
    selfTest: argv.includes("--self-test"),
    tenant,
    targetHost: hostFlag.length ? hostFlag[0].slice("--target-host=".length) : null,
  };
}

// ─── the compiled predicates (dist) ───────────────────────────────────────────────────────────────

export class DistMissingError extends Error {}

/** isOddTier (orders/units-prices-v2) and planBarcodeRows (products/product-barcode-rules), from the Nest build. */
export async function loadDist(distDir = process.env.UFR_DIST_DIR || resolve(HERE, "../dist")) {
  const files = {
    odd: join(distDir, "orders", "units-prices-v2.js"),
    barcode: join(distDir, "products", "product-barcode-rules.js"),
  };
  const build = "run `npm run build -w apps/api` first";
  for (const f of Object.values(files))
    if (!existsSync(f)) throw new DistMissingError(`the compiled output is missing (${build})`);
  const pick = async (file, name) => {
    const mod = await import(pathToFileURL(file).href);
    const fn = mod[name] ?? mod.default?.[name];
    if (typeof fn !== "function")
      throw new DistMissingError(`the compiled output has no ${name}: it is stale (${build})`);
    return fn;
  };
  return {
    isOddTier: await pick(files.odd, "isOddTier"),
    planBarcodeRows: await pick(files.barcode, "planBarcodeRows"),
  };
}

// ─── pure folding ─────────────────────────────────────────────────────────────────────────────────

/** The five-field diff tuple syncProductBarcodesFromLegacy compares rows by (product-catalog-sync.ts tupleKey). */
const tupleKey = (r) =>
  [r.code, r.level, r.origin, r.copiedFromLevel ?? "", r.primaryFor ?? ""].join("\u0000");

/** Live barcode rows (one product's) the planner would not produce for the product's current columns. */
export function staleBarcodeRows(rows, product, planBarcodeRows) {
  const want = new Set(
    planBarcodeRows({ barcode: product.barcode, unitsPerBox: product.unitsPerBox }).map(tupleKey),
  );
  return rows.filter((r) => !want.has(tupleKey(r))).length;
}

/** Held through an ACTIVE override (a DENY wins and names itself), else through the tenant's plan flags. */
export function holderOf(featureKey, overrideEffect, planFlags) {
  if (overrideEffect === "DENY") return { held: false, source: "denied" };
  if (overrideEffect === "GRANT") return { held: true, source: "override" };
  if ((planFlags ?? []).includes(featureKey)) return { held: true, source: "plan" };
  return { held: false, source: null };
}

/** Distinct odd tier values and their row count. The predicate decides; `rows` are { tier, n } candidates. */
export function oddTiers(rows, isOddTier) {
  const values = new Set();
  let count = 0;
  for (const r of rows)
    if (isOddTier(r.tier)) {
      values.add(Number(r.tier));
      count += r.n;
    }
  return { count, values: [...values] };
}

export function stopsOf(t) {
  const out = [];
  if (t.c1.total > 0 && !t.c8.unitsV1.held) out.push("C-1");
  if (t.c3.unlinkedOverflow > 0) out.push("C-3");
  if (t.c4.customers + t.c4.customerPrices > 0) out.push("C-4");
  if (t.c5.rows > 0 && !t.c8.unitsPricesV2.held) out.push("C-5");
  if (t.c6.orders + t.c6.invoices + t.c6.estimates > 0 && !t.c8.unitsV1.held) out.push("C-6");
  if (t.sa983C1.staleRows > 0) out.push("SA983-C1");
  return out;
}

const STOP_TEXT = {
  "C-1": "ProductUnit rows on a tenant that does not hold flag.units_v1",
  "C-3": "the U-6 plan leaves unit words unlinked past the 200-unit cap",
  "C-4": "customer / customer-price tiers outside 1-5 (flag-on normalises what master reads raw)",
  "C-5": "CustomerUnitPrice rows on a tenant that does not hold flag.units_prices_v2",
  "C-6":
    "unit lines in open orders / DRAFT invoices / DRAFT estimates on a tenant without flag.units_v1",
  "SA983-C1": "live ProductBarcode rows the planner would not produce",
};

const num = (m, id) => m.get(id) ?? 0;
const by = (rows, f = (r) => r.n) => {
  const m = new Map();
  for (const r of rows) if (r.tenantId != null) m.set(r.tenantId, (m.get(r.tenantId) ?? 0) + f(r));
  return m;
};

/** Pure: everything the tenant's block needs → the block. `x` holds the global aggregates and this tenant's row-level. */
export function foldTenant(tenantId, x, protectedIds = new Set()) {
  const c1 = x.c1.find((r) => r.tenantId === tenantId);
  const c7 = x.c7.find((r) => r.tenantId === tenantId);
  const cust = oddTiers(
    x.c4Customer.filter((r) => r.tenantId === tenantId),
    x.isOddTier,
  );
  const price = oddTiers(
    x.c4CustomerPrice.filter((r) => r.tenantId === tenantId),
    x.isOddTier,
  );
  const holds = Object.fromEntries(
    KEY_FIELDS.map(([field, key]) => [
      field,
      holderOf(key, x.overrides.get(`${tenantId}\u0000${key}`), x.planFlags.get(tenantId)),
    ]),
  );
  const counts = x.plan.counts;
  const t = {
    tenantId,
    protected: protectedIds.has(tenantId),
    c1: {
      total: c1?.total ?? 0,
      onNoPack: c1?.on_no_pack ?? 0,
      factorOne: c1?.factor_one ?? 0,
    },
    c2: {
      noPack: num(x.c2Count, tenantId),
      proposeHigh: x.proposals.HIGH,
      proposeMedium: x.proposals.MEDIUM,
    },
    c3: {
      created: counts.tenantUnitsCreated,
      existing: counts.tenantUnitsExisting,
      overflow: counts.tenantUnitsOverflow,
      linked: counts.productUnitsLinked,
      parentFilled: counts.productUnitsParentFilled,
      unlinkedOverflow: counts.productUnitsUnlinkedOverflow,
      skippedTooLong: counts.skippedTooLong,
      skippedSynonyms: counts.skippedSynonyms,
      skippedParent: counts.skippedParent,
    },
    c4: {
      customers: cust.count,
      customerPrices: price.count,
      oddValues: [...new Set([...cust.values, ...price.values])].sort((a, b) => a - b),
    },
    c5: { rows: num(x.c5, tenantId) },
    c6: {
      orders: num(x.c6Orders, tenantId),
      invoices: num(x.c6Invoices, tenantId),
      estimates: num(x.c6Estimates, tenantId),
    },
    c7: { products: c7?.products ?? 0, tierValues: c7?.tier_values ?? 0 },
    c8: holds,
    sa983C1: { staleRows: x.staleRows },
  };
  return { ...t, stops: stopsOf(t) };
}

export function totalsOf(tenants) {
  const sum = (f) => tenants.reduce((n, t) => n + f(t), 0);
  return {
    tenants: tenants.length,
    tenantsWithStops: tenants.filter((t) => t.stops.length > 0).length,
    productUnits: sum((t) => t.c1.total),
    customerUnitPrices: sum((t) => t.c5.rows),
    oddTierRows: sum((t) => t.c4.customers + t.c4.customerPrices),
    staleBarcodeRows: sum((t) => t.sa983C1.staleRows),
  };
}

export function formatReport(rep, meta) {
  const out = [`${NAME} · ${meta.scope} · ${meta.generatedAt} · READ ONLY`];
  if (!rep.tenants.length) out.push("no tenant matched");
  const held = (h) => (h.held ? `yes(${h.source})` : h.source ? `no(${h.source})` : "no");
  for (const t of rep.tenants) {
    out.push(`tenant ${t.tenantId}${t.protected ? " [PROTECTED]" : ""}`);
    out.push(
      `  C-1 ProductUnit rows: total=${t.c1.total} onNoPack=${t.c1.onNoPack} factorOne=${t.c1.factorOne}`,
      `  C-2 no-pack products: ${t.c2.noPack}; pack-size proposals HIGH=${t.c2.proposeHigh} MEDIUM=${t.c2.proposeMedium} (FYI)`,
      `  C-3 U-6 plan: tenantUnits created=${t.c3.created} existing=${t.c3.existing} overflow=${t.c3.overflow}; ` +
        `productUnits linked=${t.c3.linked} parentFilled=${t.c3.parentFilled} unlinkedOverflow=${t.c3.unlinkedOverflow}; ` +
        `skipped tooLong=${t.c3.skippedTooLong} synonyms=${t.c3.skippedSynonyms} parent=${t.c3.skippedParent}`,
      `  C-4 odd tiers: customers=${t.c4.customers} customerPrices=${t.c4.customerPrices}` +
        (t.c4.oddValues.length ? ` values=${t.c4.oddValues.join(",")}` : ""),
      `  C-5 CustomerUnitPrice rows: ${t.c5.rows}`,
      `  C-6 unit lines in flight: orders=${t.c6.orders} invoices=${t.c6.invoices} estimates=${t.c6.estimates}`,
      `  C-7 tier copies of Retail: products=${t.c7.products} tierValues=${t.c7.tierValues} (FYI)`,
      `  C-8 holders: units_v1=${held(t.c8.unitsV1)} units_prices_v2=${held(t.c8.unitsPricesV2)} units_settings_v1=${held(t.c8.unitsSettingsV1)}`,
      `  SA983-C1 stale ProductBarcode rows: ${t.sa983C1.staleRows}`,
    );
    for (const s of t.stops) out.push(`  STOP ${t.tenantId} ${s}: ${STOP_TEXT[s]}`);
  }
  out.push(
    `TOTAL: ${rep.totals.tenants} tenant(s), ${rep.totals.tenantsWithStops} with a STOP; ` +
      `ProductUnit rows ${rep.totals.productUnits}, CustomerUnitPrice rows ${rep.totals.customerUnitPrices}, ` +
      `odd-tier rows ${rep.totals.oddTierRows}, stale barcode rows ${rep.totals.staleBarcodeRows}`,
    "Next: any STOP goes back to the SA before D5. A tenant does not flip with a known difference.",
  );
  return out.join("\n");
}

// ─── the read ─────────────────────────────────────────────────────────────────────────────────────

export async function buildReport(client, { protectedIds, onlyTenant, dist } = {}) {
  const one = onlyTenant ?? null;
  const q = async (sql, params = [one]) => (await client.query(sql, params)).rows;

  const tenantIds = (await q(Q.tenants)).map((r) => r.tenantId);
  const keys = Object.values(KEYS);
  const overrides = new Map();
  for (const r of await q(Q.overrides, [one, keys])) {
    const k = `${r.tenantId}\u0000${r.featureKey}`;
    // a DENY outranks a GRANT, as the resolver reads it
    if (overrides.get(k) !== "DENY") overrides.set(k, r.effect);
  }
  const planFlags = new Map();
  for (const r of await q(Q.planFlags)) planFlags.set(r.tenantId, r.flags ?? []);

  const shared = {
    c1: await q(Q.c1),
    c2Count: by(await q(Q.c2Count)),
    c4Customer: await q(Q.c4Customer),
    c4CustomerPrice: await q(Q.c4CustomerPrice),
    c5: by(await q(Q.c5)),
    c6Orders: by(await q(Q.c6Orders)),
    c6Invoices: by(await q(Q.c6Invoices)),
    c6Estimates: by(await q(Q.c6Estimates)),
    c7: await q(Q.c7),
    overrides,
    planFlags,
    isOddTier: dist.isOddTier,
  };

  const tenants = [];
  for (const tenantId of tenantIds) {
    // one client, one query at a time (the read-only transaction is a single connection)
    const productUnits = await q(Q.planProductUnits, [tenantId]);
    const products = await q(Q.planProducts, [tenantId]);
    const existingUnits = await q(Q.planTenantUnits, [tenantId]);
    const plan = planTenantUnits({ productUnits, products, existingUnits });

    const proposals = { HIGH: 0, MEDIUM: 0 };
    for (const p of await q(Q.c2Rows, [tenantId])) {
      const c = classify(p);
      if (c && (c.confidence === "HIGH" || c.confidence === "MEDIUM")) proposals[c.confidence]++;
    }

    const byProduct = new Map();
    for (const r of await q(Q.barcodeRows, [tenantId])) {
      const e = byProduct.get(r.productId) ?? { product: r, rows: [] };
      e.rows.push(r);
      byProduct.set(r.productId, e);
    }
    let staleRows = 0;
    for (const { product, rows } of byProduct.values())
      staleRows += staleBarcodeRows(rows, product, dist.planBarcodeRows);

    tenants.push(foldTenant(tenantId, { ...shared, plan, proposals, staleRows }, protectedIds));
  }
  return { tenants, totals: totalsOf(tenants) };
}

// ─── self-test (no database, no dist) ─────────────────────────────────────────────────────────────

export async function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`self-test ${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  // Stand-ins for the dist predicates: the real ones are exercised by the DB spec, never copied here.
  const fakeOdd = (t) => t === 0 || t === 7 || t === 9;
  const fakePlan = ({ barcode }) =>
    barcode
      ? [
          {
            code: barcode,
            level: "UNIT",
            origin: "ENTERED",
            copiedFromLevel: null,
            primaryFor: "UNIT",
          },
        ]
      : [];

  eq(
    oddTiers(
      [
        { tier: 1, n: 5 },
        { tier: 7, n: 2 },
        { tier: 9, n: 1 },
        { tier: 7, n: 1 },
      ],
      fakeOdd,
    ),
    { count: 4, values: [7, 9] },
    "odd tiers",
  );
  eq(holderOf("k", "GRANT", []), { held: true, source: "override" }, "grant");
  eq(holderOf("k", "DENY", ["k"]), { held: false, source: "denied" }, "deny beats plan");
  eq(holderOf("k", undefined, ["k"]), { held: true, source: "plan" }, "plan");
  eq(holderOf("k", undefined, []), { held: false, source: null }, "none");

  const row = {
    code: "123",
    level: "UNIT",
    origin: "ENTERED",
    copiedFromLevel: null,
    primaryFor: "UNIT",
  };
  eq(staleBarcodeRows([row], { barcode: "123", unitsPerBox: 1 }, fakePlan), 0, "matching row");
  eq(
    staleBarcodeRows([row, { ...row, level: "BOX" }], { barcode: "123", unitsPerBox: 1 }, fakePlan),
    1,
    "extra row",
  );
  eq(staleBarcodeRows([row], { barcode: null, unitsPerBox: 1 }, fakePlan), 1, "no code, live row");

  const blank = (over = {}) => ({
    isOddTier: fakeOdd,
    overrides: new Map(),
    planFlags: new Map(),
    c1: [],
    c2Count: new Map(),
    c4Customer: [],
    c4CustomerPrice: [],
    c5: new Map(),
    c6Orders: new Map(),
    c6Invoices: new Map(),
    c6Estimates: new Map(),
    c7: [],
    plan: planTenantUnits({ productUnits: [], products: [], existingUnits: [] }),
    proposals: { HIGH: 0, MEDIUM: 0 },
    staleRows: 0,
    ...over,
  });
  eq(foldTenant("t1", blank()).stops, [], "an empty tenant has no STOP");
  const loaded = {
    c1: [{ tenantId: "t1", total: 2, on_no_pack: 1, factor_one: 1 }],
    c5: new Map([["t1", 1]]),
    c6Orders: new Map([["t1", 1]]),
    c4Customer: [{ tenantId: "t1", tier: 7, n: 1 }],
    staleRows: 2,
  };
  eq(
    foldTenant("t1", blank(loaded)).stops,
    ["C-1", "C-4", "C-5", "C-6", "SA983-C1"],
    "non-holder stops",
  );
  const holds = new Map([
    ["t1\u0000flag.units_v1", "GRANT"],
    ["t1\u0000flag.units_prices_v2", "GRANT"],
  ]);
  eq(
    foldTenant("t1", blank({ ...loaded, overrides: holds })).stops,
    ["C-4", "SA983-C1"],
    "holder stops",
  );
  eq(foldTenant("t1", blank()).protected, false, "not protected");
  eq(foldTenant("t1", blank(), new Set(["t1"])).protected, true, "protected");

  // the classifier is the shared one
  eq(classify({ name: "Cola 12CT", unit: "box" }).confidence, "HIGH", "classifier HIGH");

  for (const f of g.WRITE_FLAGS) if (checkArgs([f]).ok) throw new Error(`self-test: ${f} accepted`);
  eq(g.guardTarget(null, { host: "h" }).code, 64, "missing --target-host");
  eq(g.guardTarget("x", { host: "h" }).code, 65, "mismatched --target-host");

  const seen = [];
  const client = {
    query: async (sql) => (
      seen.push(sql),
      sql === g.SHOW_READ_ONLY ? { rows: [{ transaction_read_only: "on" }] } : { rows: [] }
    ),
  };
  await g.withReadOnlyTx(client, () =>
    buildReport(client, {
      protectedIds: new Set(),
      dist: { isOddTier: fakeOdd, planBarcodeRows: fakePlan },
    }),
  );
  eq(
    [seen[0], seen.at(-1)],
    ["SET default_transaction_read_only = on", "ROLLBACK"],
    "read-only wrapper",
  );
  for (const s of seen)
    if (/\b(insert|update|delete|alter|create|drop|truncate)\b/i.test(s))
      throw new Error(`self-test: a write statement reached the client: ${s.slice(0, 40)}`);
  return "self-test ok";
}

// ─── main ─────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  try {
    refuseRetiredFlags(argv);
  } catch (e) {
    console.error(`${NAME}: ${e.message}`);
    process.exit(2);
  }
  const args = checkArgs(argv);
  if (!args.ok) {
    console.error(`${NAME}: ${args.message}`);
    process.exit(2);
  }
  if (args.selfTest) {
    console.log(await selfTest());
    return;
  }
  const databaseUrl = resolveReportDbUrl(NAME);
  if (!databaseUrl) process.exit(2);
  const target = g.targetOf(databaseUrl);
  console.error(`${NAME}: DB host ${target.host} · database ${target.database}`);
  const guard = g.guardTarget(args.targetHost, target);
  if (!guard.ok) {
    console.error(`${NAME}: ${guard.message}`);
    process.exit(guard.code);
  }
  let dist;
  try {
    dist = await loadDist();
  } catch (e) {
    console.error(`${NAME}: ${e.message}`);
    process.exit(e instanceof DistMissingError ? 2 : 1);
  }
  let slugs;
  try {
    slugs = loadProtectedSlugs(process.env, databaseUrl);
  } catch (e) {
    console.error(`${NAME}: ${e.message}`);
    process.exit(2);
  }
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const report = await g.withReadOnlyTx(client, async () => {
      const protectedIds = new Set(await protectedTenantIds(client, slugs));
      return buildReport(client, { protectedIds, onlyTenant: args.tenant, dist });
    });
    const meta = {
      generatedAt: new Date().toISOString(),
      scope: args.tenant ? "one tenant" : "all tenants",
    };
    console.log(
      args.json ? JSON.stringify({ ...meta, ...report }, null, 2) : formatReport(report, meta),
    );
  } finally {
    await client.end().catch(() => {});
  }
}

export function isInvokedDirectly(entry = process.argv[1], self = fileURLToPath(import.meta.url)) {
  if (!entry) return false;
  const norm = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return norm(entry) === norm(self) || basename(entry) === basename(self);
}

if (isInvokedDirectly()) {
  main().catch((e) => {
    console.error(`${NAME}: ${e.message}`);
    process.exit(1);
  });
}
