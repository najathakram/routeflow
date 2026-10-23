/**
 * READ-ONLY, COUNTS-ONLY census for the money-parity CQ-02 finding: tax-exempt customers' ORDERS that carry tax.
 *
 * Before the order writers read `Customer.isTaxExempt` (fix/counter-money-parity), create, the pending merges, the staff edit,
 * the change-request apply and standing orders stored the regular sales tax in `Order.tax` and a levy snapshot in
 * `OrderItem.categoryTaxAmount` for an EXEMPT customer, while the invoice (RF-079) zeroed both. This reports how many
 * production orders are in that state, how much tax they overstate, and how many are already invoiced (to show the
 * invoices are right: the invoice tax of those orders should be 0).
 *
 *   railway run --service postgres node apps/api/scripts/report-exempt-orders-taxed.mjs [--json]
 *   node apps/api/scripts/report-exempt-orders-taxed.mjs --self-test      (no database)
 *
 * WHAT IT COUNTS (PRODUCTION tenants, not deleted): orders created on or after 2026-04-30 (the day the invoice began
 * zeroing exempt tax, RF-079), not DRAFT and not CANCELLED, whose customer is CURRENTLY flagged tax-exempt, with
 * `Order.tax > 0` OR a non-cancelled line carrying `categoryTaxAmount > 0`. Per anonymous tenant bucket and in total:
 *   - orders              the affected orders;
 *   - overstatedTax       Σ (Order.tax + Σ line levy): the tax the order total carries that the exempt customer owes;
 *   - invoiced            ...of which have at least one live (not VOID / WRITTEN_OFF) invoice;
 *   - invoicedTaxFree     ...whose live invoices all carry taxAmount = 0 (the invoice is correct);
 *   - invoicedStillTaxed  ...with a live invoice taxAmount > 0 (needs a look; expected 0).
 * The flag is read as it is NOW: a customer exempted after some of these orders is counted for them too.
 *
 * OUTPUT is COUNTS ONLY: tenants are anonymous labels ("tenant-1"...), no tenant id, slug or name, no customer, order or
 * invoice identifier of any kind. No data is changed; the remedy (credit notes) is the owner's per tenant.
 *
 * SAFETY: `default_transaction_read_only = on` before any other query; `statement_timeout` and `lock_timeout` cap every
 * query; the target is the one `resolveReportDbUrl` resolves (the redacted target goes to stderr; nothing usable = exit
 * 2 without connecting); only SELECT statements appear below; the connection is closed in `finally`.
 */
import { createRequire } from "module";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);

const NAME = "report-exempt-orders-taxed";

/** The day the invoice writers began zeroing an exempt customer's tax (RF-079). */
export const SINCE = "2026-04-30";

/**
 * One row per affected order, numbers only. `tenant_no` is an anonymous rank over the tenant column (never the id).
 * The levy is the non-cancelled lines' stored amount; the invoice columns count LIVE invoices only.
 */
export const ORDERS_SQL = `SELECT DENSE_RANK() OVER (ORDER BY x.tn)::int AS tenant_no,
       x."orderTax"::text AS order_tax,
       x.levy::text AS levy,
       x.invoices::int AS invoices,
       x."invoiceTaxed"::int AS invoice_taxed
  FROM (
    SELECT o."tenantId" AS tn,
           o.tax AS "orderTax",
           COALESCE((SELECT SUM(i."categoryTaxAmount") FROM "OrderItem" i
                      WHERE i."orderId" = o.id AND i.status::text <> 'CANCELLED'), 0) AS levy,
           (SELECT COUNT(*) FROM "Invoice" v
             WHERE v."orderId" = o.id AND v.status::text NOT IN ('VOID', 'WRITTEN_OFF')) AS invoices,
           (SELECT COUNT(*) FROM "Invoice" v
             WHERE v."orderId" = o.id AND v.status::text NOT IN ('VOID', 'WRITTEN_OFF')
               AND v."taxAmount" > 0) AS "invoiceTaxed"
      FROM "Order" o
      JOIN "Customer" c ON c.id = o."customerId" AND c."isTaxExempt" = true
      JOIN "Tenant" t ON t.id = o."tenantId" AND t.class::text = 'PRODUCTION' AND t."deletedAt" IS NULL
     WHERE o."createdAt" >= '${SINCE}' AND o.status::text NOT IN ('DRAFT', 'CANCELLED')
  ) x
 WHERE x."orderTax" > 0 OR x.levy > 0`;

const cents = (v) => Math.round((Number(v ?? 0) || 0) * 100);
const money = (c) => (c / 100).toFixed(2);

/** Pure: fold the per-order rows into per-tenant buckets and a total. Keeps no identifier. */
export function summarize(rows) {
  const zero = () => ({
    orders: 0,
    overstatedCents: 0,
    invoiced: 0,
    invoicedTaxFree: 0,
    invoicedStillTaxed: 0,
  });
  const total = zero();
  const byTenant = new Map();
  for (const r of rows) {
    const b = byTenant.get(r.tenant_no) ?? zero();
    byTenant.set(r.tenant_no, b);
    for (const block of [total, b]) {
      block.orders += 1;
      block.overstatedCents += cents(r.order_tax) + cents(r.levy);
      if (Number(r.invoices) > 0) {
        block.invoiced += 1;
        if (Number(r.invoice_taxed) > 0) block.invoicedStillTaxed += 1;
        else block.invoicedTaxFree += 1;
      }
    }
  }
  const tenants = [...byTenant.values()]
    .sort((a, b) => b.orders - a.orders || b.overstatedCents - a.overstatedCents)
    .map((b, i) => ({ label: `tenant-${i + 1}`, ...b }));
  return { total, tenants };
}

/** No-DB checks of the pure parts and the SQL text (`--self-test`). Throws on the first failure. */
export function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  const s = summarize([
    { tenant_no: 1, order_tax: "4.36", levy: "0", invoices: 1, invoice_taxed: 0 },
    { tenant_no: 1, order_tax: "0", levy: "2.80", invoices: 0, invoice_taxed: 0 },
    { tenant_no: 2, order_tax: "1.65", levy: "0.40", invoices: 2, invoice_taxed: 1 },
  ]);
  eq([s.total.orders, money(s.total.overstatedCents), s.total.invoiced], [3, "9.21", 2], "totals");
  eq([s.total.invoicedTaxFree, s.total.invoicedStillTaxed], [1, 1], "invoice classes");
  eq(
    s.tenants.map((t) => [t.label, t.orders, money(t.overstatedCents)]),
    [
      ["tenant-1", 2, "7.16"],
      ["tenant-2", 1, "2.05"],
    ],
    "anonymous tenants, largest first",
  );
  eq(summarize([]), { total: summarize([]).total, tenants: [] }, "empty");
  // the one SELECT list the report returns carries no identifier, slug, name or email
  const outerSelect = ORDERS_SQL.split(/\n\s*FROM \(/)[0];
  if (/\bslug\b|\bemail\b|businessName|\bAS\s+"?(id|tenantId|orderId)"?\b/i.test(outerSelect))
    throw new Error("the SELECT list must not carry an id, slug, name or email");
  if (/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|COPY)\b/i.test(ORDERS_SQL))
    throw new Error("the report SQL must be read-only");
  return "self-test ok";
}

function printBlock(name, b) {
  console.log(
    `${name}: ${b.orders} order(s), overstated tax $${money(b.overstatedCents)}; ` +
      `${b.invoiced} invoiced (${b.invoicedTaxFree} tax-free, ${b.invoicedStillTaxed} still taxed)`,
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
    const { rows } = await client.query(ORDERS_SQL);
    const report = summarize(rows);
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(
        `\n=== TAX-EXEMPT CUSTOMERS' ORDERS CARRYING TAX, since ${SINCE} (counts only) ===`,
      );
      printBlock("all", report.total);
      for (const t of report.tenants) printBlock(`  ${t.label}`, t);
      if (report.tenants.length === 0) console.log("  no affected orders");
      console.log(
        "\nInvoices zero an exempt customer's tax (RF-079): 'still taxed' should be 0. No data is changed; any remedy is the owner's, per tenant.",
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
