/**
 * READ-ONLY, COUNTS-ONLY census for the SA-761 sales-tax snapshot (T15, the B294 `Order.taxRate` backfill's first step):
 * how many orders carry a stamped rate, how many do not, and for the ones that do not, whether the rate can be PROVEN from
 * the order's own stored totals. Nothing here writes; the backfill (select `IS NULL`, never a date or a cutoff: SA-829) is
 * a later, separate, owner-run script that waits on the T-1 writers and sitting #4.
 *
 *   railway run --service postgres node apps/api/scripts/report-order-taxrate-census.mjs [--json]
 *   node apps/api/scripts/report-order-taxrate-census.mjs --self-test      (no database)
 *
 * WHAT IT COUNTS (PRODUCTION tenants, not deleted; orders that are not DRAFT and not CANCELLED). Per anonymous tenant
 * bucket and in total:
 *   - orders              the orders in scope;
 *   - stamped             `Order.taxRate IS NOT NULL`, split by `taxRateSource`: tenantDefault, customerExempt,
 *                         legacyInferred, and stampedNoSource (a rate with no source, which should be 0);
 *   - unstamped           `Order.taxRate IS NULL`: the population a backfill would select. Split by what the stored
 *                         totals prove (regular tax = Order.tax, base = Order.subtotal):
 *       noTax               tax = 0 (nothing to infer);
 *       verified            the tenant's own rate (settings.taxRate) reproduces the stored tax to the cent on the subtotal
 *                           (@routeflow/pricing's inferredGoodsFlatRate, the rule the B294 backfill uses);
 *       verifiedNetOfDiscount  the tenant's rate does not on the subtotal but does on subtotal - discountAmount (the
 *                           discount-reduces-the-base question, rows 406-408, answered per order, never guessed);
 *       otherRate           some OTHER flat rate reproduces the tax (the tenant's rate changed, or the order was taxed
 *                           at a customer-specific rate): provable, but not the tenant's current one;
 *       unverified          tax > 0 and no flat rate reproduces it (a rounding mismatch, or a tax that is not flat);
 *       subtotalZero        tax > 0 on a subtotal of 0 (unverifiable);
 *   - lines / linesUnstamped   non-cancelled order lines, and those with `OrderItem.taxRate IS NULL`.
 * If the sitting-#4 columns are not on the database yet, it says so and exits 0 (nothing to count).
 *
 * OUTPUT is COUNTS ONLY: tenants are anonymous labels ("tenant-1"...), no tenant id, slug or name, no customer, order or
 * invoice identifier of any kind. No data is changed.
 *
 * SAFETY: `default_transaction_read_only = on` before any other query, read back; `statement_timeout` and `lock_timeout`
 * cap every query; the target is the one `resolveReportDbUrl` resolves (the redacted target goes to stderr; nothing usable
 * = exit 2 without connecting); only SELECT statements appear below; the connection is closed in `finally`.
 */
import { createRequire } from "module";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { inferredGoodsFlatRate } from "@routeflow/pricing";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);

const NAME = "report-order-taxrate-census";

/** The three sitting-#4 columns the census reads; absent = the migration has not been applied to this database. */
export const REQUIRED_COLUMNS = [
  ["Order", "taxRate"],
  ["Order", "taxRateSource"],
  ["OrderItem", "taxRate"],
];

export const COLUMNS_SQL = `SELECT table_name AS t, column_name AS c FROM information_schema.columns
 WHERE table_schema = current_schema()
   AND ((table_name = 'Order' AND column_name IN ('taxRate', 'taxRateSource'))
     OR (table_name = 'OrderItem' AND column_name = 'taxRate'))`;

/** One anonymous rank per production tenant, shared by both queries so the labels line up. */
const TENANTS_CTE = `WITH tn AS (
  SELECT t.id, DENSE_RANK() OVER (ORDER BY t.id)::int AS n
    FROM "Tenant" t WHERE t.class::text = 'PRODUCTION' AND t."deletedAt" IS NULL
)`;

/** Per tenant: order counts by stamp and source, and the line counts. Numbers only. */
export const COUNTS_SQL = `${TENANTS_CTE}
SELECT tn.n AS tenant_no,
       COUNT(*)::int AS orders,
       COUNT(*) FILTER (WHERE o."taxRate" IS NOT NULL AND o."taxRateSource"::text = 'TENANT_DEFAULT')::int AS tenant_default,
       COUNT(*) FILTER (WHERE o."taxRate" IS NOT NULL AND o."taxRateSource"::text = 'CUSTOMER_EXEMPT')::int AS customer_exempt,
       COUNT(*) FILTER (WHERE o."taxRate" IS NOT NULL AND o."taxRateSource"::text = 'LEGACY_INFERRED')::int AS legacy_inferred,
       COUNT(*) FILTER (WHERE o."taxRate" IS NOT NULL AND o."taxRateSource" IS NULL)::int AS stamped_no_source,
       COUNT(*) FILTER (WHERE o."taxRate" IS NULL)::int AS unstamped,
       COALESCE(SUM(l.lines), 0)::int AS lines,
       COALESCE(SUM(l.lines_unstamped), 0)::int AS lines_unstamped
  FROM "Order" o
  JOIN tn ON tn.id = o."tenantId"
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS lines, COUNT(*) FILTER (WHERE i."taxRate" IS NULL) AS lines_unstamped
      FROM "OrderItem" i WHERE i."orderId" = o.id AND i.status::text <> 'CANCELLED'
  ) l ON true
 WHERE o.status::text NOT IN ('DRAFT', 'CANCELLED')
 GROUP BY tn.n`;

/** One row per UNSTAMPED order with tax or a subtotal to look at (numbers only), for the proof classes. */
export const UNSTAMPED_SQL = `${TENANTS_CTE}
SELECT tn.n AS tenant_no, o.subtotal::text AS subtotal, o.tax::text AS tax, o."discountAmount"::text AS discount,
       sc.value::text AS tenant_rate_pct
  FROM "Order" o
  JOIN tn ON tn.id = o."tenantId"
  LEFT JOIN "SystemConfig" sc ON sc."tenantId" = o."tenantId" AND sc.key = 'settings.taxRate'
 WHERE o.status::text NOT IN ('DRAFT', 'CANCELLED') AND o."taxRate" IS NULL AND o.tax > 0`;

const num = (v) => Number(v ?? 0) || 0;
const cents = (v) => Math.round(num(v) * 100);

/** settings.taxRate (a PERCENT string) -> the tenant's rate as a 6-dp fraction, or null (none / invalid / out of range). */
export function tenantRateFraction(value) {
  const pct = Number(value);
  if (value == null || !Number.isFinite(pct) || !(pct > 0) || pct > 100) return null;
  return Math.round((pct / 100) * 1_000_000) / 1_000_000;
}

/**
 * Pure: what the order's own stored totals prove about its tax rate. Only orders with tax > 0 reach the proof query; the
 * `noTax` branch is kept so the function is total.
 */
export function classifyUnstamped({ subtotal, tax, discount, tenantRatePct }) {
  if (cents(tax) <= 0) return "noTax";
  if (cents(subtotal) <= 0) return "subtotalZero";
  const preferred = tenantRateFraction(tenantRatePct);
  const prove = (base) =>
    inferredGoodsFlatRate(
      { subtotal: base, taxAmount: tax, lines: [{ taxRate: 0, categoryTaxAmount: 0 }] },
      { preferredRate: preferred },
    );
  const onSubtotal = prove(num(subtotal));
  if (onSubtotal?.verified && preferred != null && onSubtotal.rate === preferred) return "verified";
  const net = (cents(subtotal) - cents(discount)) / 100;
  if (preferred != null && cents(discount) > 0 && net > 0) {
    const onNet = prove(net);
    if (onNet?.verified && onNet.rate === preferred) return "verifiedNetOfDiscount";
  }
  if (onSubtotal?.verified) return "otherRate";
  return "unverified";
}

const zero = () => ({
  orders: 0,
  stamped: { tenantDefault: 0, customerExempt: 0, legacyInferred: 0, stampedNoSource: 0 },
  unstamped: {
    total: 0,
    noTax: 0,
    verified: 0,
    verifiedNetOfDiscount: 0,
    otherRate: 0,
    unverified: 0,
    subtotalZero: 0,
  },
  lines: 0,
  linesUnstamped: 0,
});

/**
 * Pure: fold the per-tenant count rows and the unstamped order rows into anonymous buckets and a total.
 * Keeps no identifier: tenant_no is only used to join the two result sets, labels are re-ranked by size.
 */
export function summarize(countRows, unstampedRows) {
  const byNo = new Map();
  for (const r of countRows) {
    const b = zero();
    b.orders = Number(r.orders);
    b.stamped = {
      tenantDefault: Number(r.tenant_default),
      customerExempt: Number(r.customer_exempt),
      legacyInferred: Number(r.legacy_inferred),
      stampedNoSource: Number(r.stamped_no_source),
    };
    b.unstamped.total = Number(r.unstamped);
    b.lines = Number(r.lines);
    b.linesUnstamped = Number(r.lines_unstamped);
    byNo.set(r.tenant_no, b);
  }
  const taxed = new Map();
  for (const r of unstampedRows) {
    const b = byNo.get(r.tenant_no);
    if (!b) continue;
    const cls = classifyUnstamped({
      subtotal: r.subtotal,
      tax: r.tax,
      discount: r.discount,
      tenantRatePct: r.tenant_rate_pct,
    });
    b.unstamped[cls] += 1;
    taxed.set(r.tenant_no, (taxed.get(r.tenant_no) ?? 0) + 1);
  }
  for (const [no, b] of byNo) b.unstamped.noTax = b.unstamped.total - (taxed.get(no) ?? 0);
  const total = zero();
  for (const b of byNo.values()) {
    total.orders += b.orders;
    for (const k of Object.keys(total.stamped)) total.stamped[k] += b.stamped[k];
    for (const k of Object.keys(total.unstamped)) total.unstamped[k] += b.unstamped[k];
    total.lines += b.lines;
    total.linesUnstamped += b.linesUnstamped;
  }
  const tenants = [...byNo.values()]
    .sort((a, b) => b.orders - a.orders)
    .map((b, i) => ({ label: `tenant-${i + 1}`, ...b }));
  return { total, tenants };
}

/** No-DB checks of the pure parts and the SQL text (`--self-test`). Throws on the first failure. */
export function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  const T = "8.25"; // the tenant's settings.taxRate, a percent
  const c = (subtotal, tax, discount = "0", tenantRatePct = T) =>
    classifyUnstamped({ subtotal, tax, discount, tenantRatePct });
  eq(c("100.00", "0.00"), "noTax", "no tax");
  eq(c("100.00", "8.25"), "verified", "the tenant rate reproduces");
  eq(c("0.00", "5.00"), "subtotalZero", "subtotal 0");
  eq(
    c("100.00", "6.60", "20.00"),
    "verifiedNetOfDiscount",
    "discount reduces the base (80 x 8.25%)",
  );
  eq(c("100.00", "7.33"), "otherRate", "a different flat rate reproduces");
  eq(
    c("100.00", "8.25", "0", null),
    "otherRate",
    "no tenant rate configured: provable, not the tenant's",
  );
  eq(c("100000.00", "7.33"), "unverified", "no flat rate reproduces it");
  const s = summarize(
    [
      {
        tenant_no: 1,
        orders: 5,
        tenant_default: 1,
        customer_exempt: 0,
        legacy_inferred: 0,
        stamped_no_source: 0,
        unstamped: 4,
        lines: 9,
        lines_unstamped: 6,
      },
      {
        tenant_no: 2,
        orders: 2,
        tenant_default: 0,
        customer_exempt: 0,
        legacy_inferred: 0,
        stamped_no_source: 1,
        unstamped: 1,
        lines: 1,
        lines_unstamped: 1,
      },
    ],
    [
      { tenant_no: 1, subtotal: "100.00", tax: "8.25", discount: "0", tenant_rate_pct: T },
      { tenant_no: 1, subtotal: "100000.00", tax: "7.33", discount: "0", tenant_rate_pct: T },
      { tenant_no: 2, subtotal: "0.00", tax: "1.00", discount: "0", tenant_rate_pct: T },
    ],
  );
  eq([s.total.orders, s.total.unstamped.total, s.total.unstamped.noTax], [7, 5, 2], "totals");
  eq(s.total.stamped.stampedNoSource, 1, "a rate with no source is carried, not dropped");
  eq(
    [s.total.unstamped.verified, s.total.unstamped.unverified, s.total.unstamped.subtotalZero],
    [1, 1, 1],
    "proof classes",
  );
  eq(
    s.tenants.map((t) => [t.label, t.orders]),
    [
      ["tenant-1", 5],
      ["tenant-2", 2],
    ],
    "anonymous, largest first",
  );
  eq(summarize([], []).tenants, [], "empty");
  for (const sql of [COUNTS_SQL, UNSTAMPED_SQL, COLUMNS_SQL]) {
    if (/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|COPY)\b/i.test(sql))
      throw new Error("the report SQL must be read-only");
  }
  // both queries rank only live production tenants (a demo, test or soft-deleted tenant is never counted)
  for (const sql of [COUNTS_SQL, UNSTAMPED_SQL]) {
    if (!sql.includes("t.class::text = 'PRODUCTION'") || !sql.includes('t."deletedAt" IS NULL'))
      throw new Error("the report SQL must keep to live PRODUCTION tenants");
  }
  // the SELECT lists carry no identifier, slug, name or email
  for (const sql of [COUNTS_SQL, UNSTAMPED_SQL]) {
    const list = sql
      .split(/\n\s*FROM "Order"/)[0]
      .split("SELECT")
      .pop();
    if (/\bslug\b|\bemail\b|businessName|\bAS\s+"?(id|tenantId|orderId)"?\b|\bo\.id\b/i.test(list))
      throw new Error("the SELECT list must not carry an id, slug, name or email");
  }
  return "self-test ok";
}

function printBlock(name, b) {
  const st = b.stamped;
  const un = b.unstamped;
  console.log(
    `${name}: ${b.orders} order(s); stamped ${st.tenantDefault + st.customerExempt + st.legacyInferred + st.stampedNoSource} ` +
      `(tenant default ${st.tenantDefault}, exempt ${st.customerExempt}, legacy inferred ${st.legacyInferred}, no source ${st.stampedNoSource}); ` +
      `unstamped ${un.total} (no tax ${un.noTax}, verified ${un.verified}, net of discount ${un.verifiedNetOfDiscount}, other rate ${un.otherRate}, ` +
      `unverified ${un.unverified}, subtotal 0 ${un.subtotalZero}); lines ${b.lines}, unstamped ${b.linesUnstamped}`,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    console.log(selfTest());
    return;
  }
  const json = argv.includes("--json");
  const databaseUrl = resolveReportDbUrl(NAME);
  if (!databaseUrl) process.exit(2);
  const { Client } = require("pg");
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '60s'");
    await client.query("SET lock_timeout = '5s'");
    const ro = (await client.query("SHOW default_transaction_read_only")).rows[0];
    if (ro?.default_transaction_read_only !== "on")
      throw new Error("the session is not read-only; refusing to run");
    await client.query("BEGIN READ ONLY");
    const present = new Set((await client.query(COLUMNS_SQL)).rows.map((r) => `${r.t}.${r.c}`));
    const missing = REQUIRED_COLUMNS.map(([t, c]) => `${t}.${c}`).filter((k) => !present.has(k));
    if (missing.length > 0) {
      await client.query("ROLLBACK");
      if (json) console.log(JSON.stringify({ columns: "missing", missing }, null, 2));
      else
        console.log(
          `The tax-rate snapshot columns are not on this database yet (missing: ${missing.join(", ")}). ` +
            "Nothing to count; run this again after the sitting that adds them.",
        );
      return;
    }
    const counts = (await client.query(COUNTS_SQL)).rows;
    const unstamped = (await client.query(UNSTAMPED_SQL)).rows;
    await client.query("ROLLBACK");
    const report = summarize(counts, unstamped);
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log("\n=== ORDER TAX-RATE SNAPSHOT CENSUS (counts only) ===");
      printBlock("all", report.total);
      for (const t of report.tenants) printBlock(`  ${t.label}`, t);
      if (report.tenants.length === 0) console.log("  no orders in scope");
      console.log(
        "\nNo data is changed. 'unstamped' is what a backfill would select (IS NULL, never a date); 'unverified' and 'subtotal 0' rows need a person.",
      );
    }
  } finally {
    await client.end().catch(() => {});
  }
}

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
      `${NAME}: warning: entry path ${entry} did not match ${self} exactly; running anyway.`,
    );
    return true;
  }
  return false;
}

if (isInvokedDirectly()) {
  main().catch((e) => {
    console.error(`${NAME}: ${e.message}`);
    process.exit(1);
  });
}
