/**
 * S27c (units v2 plan, owner Q3 / M7): READ-ONLY census of LEGACY PARENTS - active STANDARD products that other
 * products point at through `parentProductId` and that may still be sold themselves. Q3: "old parents that still sell
 * become families, business by business, after a count". This is the count; it changes nothing.
 *
 *   railway run --service postgres node apps/api/scripts/units-legacy-parent-census.mjs --tenant acme [--json]
 *   railway run --service postgres node apps/api/scripts/units-legacy-parent-census.mjs --all [--json]
 *   node apps/api/scripts/units-legacy-parent-census.mjs --self-test                      (no database)
 *
 * A row is counted when its tenant is not deleted and the product is STANDARD, active, has no parent of its own, and
 * has at least one child variant in the same tenant. Per tenant it reports:
 *   parents / children / activeChildren   how many parents, and their child rows (all, active)
 *   soldAsParent90 / soldAsChild90        parents whose OWN line, or a CHILD's line, sits on an order (not draft or
 *                                         cancelled) or an invoice (not draft or void) in the last 90 days;
 *                                         soldAsBoth90 is the overlap
 *   withStock / withPrice                 parents with stock on hand above zero / a price above zero
 *   withOpenLines                         parents on a live order line now (M7 refuses these)
 *   noActiveChildren                      parents whose children are all inactive
 *   tenantsScanned                        tenants checked (zero-parent tenants included); --all = PRODUCTION only
 *
 * OUTPUT is COUNTS ONLY under anonymous labels (tenant-1, tenant-2): no slug, name, id or product data. The slug is
 * an input only. Convention mirrored from report-read-only-sellers-with-buyers: the one report-db-url resolution
 * (redacted target on stderr, none usable = exit 2 without connecting), `default_transaction_read_only = on` first,
 * statement and lock timeouts, SELECT only, connection closed in `finally`. Like that report it is a read, not a
 * test action, so it is not restricted to the approved test tenants. Exit: 0 report printed, 2 usage or env error.
 */
import { createRequire } from "module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);

const NAME = "units-legacy-parent-census";
const WINDOW = "now() - interval '90 days'";
const LIVE_ORDER = "('PENDING','CONFIRMED','OUT_FOR_DELIVERY','PARTIALLY_DELIVERED')";

/** An order or invoice line, in the parent's tenant, on `product` (a column or sub-select condition), recent only. */
const line = (productCond, { recent }) => `(
    EXISTS (SELECT 1 FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId"
             WHERE ${productCond("oi")} AND o."tenantId" = p."tenantId"
               AND ${recent ? `o.status NOT IN ('DRAFT','CANCELLED') AND o."createdAt" >= ${WINDOW}` : `o.status IN ${LIVE_ORDER}`})
    ${
      recent
        ? `OR EXISTS (SELECT 1 FROM "InvoiceItem" ii JOIN "Invoice" i ON i.id = ii."invoiceId"
             WHERE ${productCond("ii")} AND i."tenantId" = p."tenantId"
               AND i.status NOT IN ('DRAFT','VOID') AND i."issueDate" >= ${WINDOW})`
        : ""
    })`;
const own = (a) => `${a}."productId" = p.id`;
const childOf = (a) =>
  `${a}."productId" IN (SELECT c.id FROM "Product" c WHERE c."parentProductId" = p.id AND c."tenantId" = p."tenantId")`;
const kids = (extra = "") =>
  `(SELECT COUNT(*)::int FROM "Product" c WHERE c."parentProductId" = p.id AND c."tenantId" = p."tenantId"${extra})`;

/** $1 = a tenant slug (any class), or NULL for --all, which covers live PRODUCTION tenants only. */
const TENANT_SCOPE = `t."deletedAt" IS NULL AND ($1::text IS NULL OR t.slug = $1)
   AND ($1::text IS NOT NULL OR t.class = 'PRODUCTION')`;

/** One row per legacy parent. $1 = a tenant slug, or NULL for every tenant. */
export const CENSUS_SQL = `SELECT p."tenantId" AS tenant_key,
       ${kids()} AS children,
       ${kids(' AND c."isActive"')} AS active_children,
       ${line(own, { recent: true })} AS sold_parent,
       ${line(childOf, { recent: true })} AS sold_child,
       ${line(own, { recent: false })} AS open_lines,
       p."currentStock" > 0 AS has_stock,
       p."pricePerUnit" > 0 AS has_price
  FROM "Product" p
  JOIN "Tenant" t ON t.id = p."tenantId"
 WHERE ${TENANT_SCOPE}
   AND p.kind = 'STANDARD' AND p."isActive" AND p."parentProductId" IS NULL
   AND ${kids()} > 0`;

export const TENANT_COUNT_SQL = `SELECT COUNT(*)::int AS n FROM "Tenant" t WHERE ${TENANT_SCOPE}`;

const zero = () => ({
  parents: 0,
  children: 0,
  activeChildren: 0,
  soldAsParent90: 0,
  soldAsChild90: 0,
  soldAsBoth90: 0,
  withStock: 0,
  withPrice: 0,
  withOpenLines: 0,
  noActiveChildren: 0,
});

/** Pure: fold per-parent rows into per-tenant counts under anonymous labels. The tenant key never leaves. */
export function summarize(rows, tenantsScanned = null) {
  const keys = [...new Set(rows.map((r) => r.tenant_key))].sort();
  const label = new Map(keys.map((k, i) => [k, `tenant-${i + 1}`]));
  const per = new Map(keys.map((k) => [k, { label: label.get(k), ...zero() }]));
  const total = zero();
  for (const r of rows) {
    for (const b of [per.get(r.tenant_key), total]) {
      b.parents += 1;
      b.children += r.children;
      b.activeChildren += r.active_children;
      if (r.active_children === 0) b.noActiveChildren += 1;
      if (r.sold_parent) b.soldAsParent90 += 1;
      if (r.sold_child) b.soldAsChild90 += 1;
      if (r.sold_parent && r.sold_child) b.soldAsBoth90 += 1;
      if (r.has_stock) b.withStock += 1;
      if (r.has_price) b.withPrice += 1;
      if (r.open_lines) b.withOpenLines += 1;
    }
  }
  return {
    tenantsScanned: tenantsScanned ?? keys.length,
    tenants: keys.map((k) => per.get(k)),
    total,
  };
}

const COLS = [
  ["parents", "parents"],
  ["children", "children"],
  ["activeChildren", "active"],
  ["soldAsParent90", "sold-parent"],
  ["soldAsChild90", "sold-child"],
  ["soldAsBoth90", "both"],
  ["withStock", "stock"],
  ["withPrice", "price"],
  ["withOpenLines", "open-lines"],
  ["noActiveChildren", "no-active"],
];

/** Pure: the short text table (one line per tenant plus TOTAL). */
export function formatTable(report) {
  const head = ["tenant", ...COLS.map((c) => c[1])];
  const body = [...report.tenants, { ...report.total, label: "TOTAL" }].map((t) => [
    t.label,
    ...COLS.map((c) => String(t[c[0]])),
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const fmt = (r) =>
    r
      .map((v, i) => v.padEnd(w[i]))
      .join("  ")
      .trimEnd();
  return [
    `tenants scanned: ${report.tenantsScanned}`,
    "",
    fmt(head),
    fmt(w.map((n) => "-".repeat(n))),
    ...body.map(fmt),
  ].join("\n");
}

/** Pure: `--tenant <slug>` xor `--all`, plus `--json` and `--self-test`. Throws a usage message otherwise. */
export function parseArgs(argv) {
  const i = argv.indexOf("--tenant");
  const tenant = i >= 0 ? argv[i + 1] : null;
  if (i >= 0 && (!tenant || tenant.startsWith("--")))
    throw new Error("--tenant needs a slug (e.g. --tenant acme)");
  const all = argv.includes("--all");
  const selfTest = argv.includes("--self-test");
  if (!selfTest && !all && !tenant) throw new Error("pass --tenant <slug> (e.g. acme) or --all");
  if (all && tenant) throw new Error("pass either --tenant <slug> or --all, not both");
  return { tenant: tenant ?? null, all, json: argv.includes("--json"), selfTest };
}

/** No-DB checks of the pure parts (`--self-test`). Throws on the first failure. */
export function selfTest() {
  const r = summarize([
    {
      tenant_key: "k2",
      children: 2,
      active_children: 1,
      sold_parent: true,
      sold_child: true,
      open_lines: false,
      has_stock: true,
      has_price: true,
    },
    {
      tenant_key: "k1",
      children: 4,
      active_children: 4,
      sold_parent: false,
      sold_child: true,
      open_lines: true,
      has_stock: false,
      has_price: false,
    },
  ]);
  const got = JSON.stringify([
    r.tenants[0].label,
    r.tenants[0].soldAsChild90,
    r.total.parents,
    r.total.soldAsBoth90,
    r.total.children,
  ]);
  if (got !== JSON.stringify(["tenant-1", 1, 2, 1, 6])) throw new Error(`summarize: ${got}`);
  if (JSON.stringify(r).includes("k1")) throw new Error("a tenant key leaked into the report");
  if (!formatTable(r).includes("TOTAL")) throw new Error("table has no TOTAL row");
  if (parseArgs(["--tenant", "acme"]).tenant !== "acme") throw new Error("parseArgs");
  return "self-test ok";
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${NAME}: ${e.message}`);
    return 2;
  }
  if (args.selfTest) {
    console.log(selfTest());
    return 0;
  }
  const url = resolveReportDbUrl(NAME);
  if (!url) return 2;
  const { Client } = require("pg");
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '60s'");
    await client.query("SET lock_timeout = '5s'");
    const scope = [args.all ? null : args.tenant];
    const { rows: n } = await client.query(TENANT_COUNT_SQL, scope);
    if (n[0].n === 0) {
      console.error(`${NAME}: no such tenant`);
      return 2;
    }
    const { rows } = await client.query(CENSUS_SQL, scope);
    const report = summarize(rows, n[0].n);
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log("\n=== LEGACY PARENTS WITH VARIANTS (active STANDARD, counts only) ===");
      console.log(formatTable(report));
      console.log(
        "\nSales window: last 90 days. Q3: a parent that still sells becomes a family only after this count.",
      );
    }
    return 0;
  } finally {
    await client.end().catch(() => {});
  }
}

const norm = (p) => {
  try {
    return realpathSync(p).toLowerCase();
  } catch {
    return String(p).toLowerCase();
  }
};
if (process.argv[1] && norm(process.argv[1]) === norm(fileURLToPath(import.meta.url))) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`${NAME}: ${e.message}`);
      process.exit(1);
    },
  );
}
