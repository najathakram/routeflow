/**
 * READ-ONLY report (B1053 / SA-704): Invoices and Transactions whose `orderId` is NULL — the footprint
 * of the pending-order merge race, where `order.delete` on a loser SET the racing document's `orderId`
 * to NULL (Invoice -> Order and Transaction -> Order are ON DELETE SET NULL).
 *
 * DISCRIMINATOR. A durable "this was orphaned by a merge" marker does not exist: the FK nulls the
 * column and leaves no trace. What IS durable is the negative space of the legitimate order-less
 * Invoices — recurring (`recurringInvoiceId`), estimate-converted (an Estimate row points at it),
 * NSF fee (`feeForPaymentId`), delivery-batch (`deliveryBatchId`), grouped (`invoiceGroupId`). An
 * Invoice with none of those and `orderId` NULL is either a manual invoice (legitimate) or an orphan, and
 * the data cannot tell which, so every such row is `REVIEW` for the office. A Transaction is created only
 * from an order, so any Transaction with `orderId` NULL is `SUSPECT`.
 *
 * OUTPUT. Per tenant, COUNTS only. Row ids (never customer names, never amounts) are printed ONLY for
 * approved test tenants (`isTestTenant`); a live tenant's slug is not printed either, it is shown as
 * `live-<n>`. Run it locally / against a test DB; against production the owner runs it:
 *   railway run --service postgres node apps/api/scripts/report-orphaned-order-docs-b1053.mjs
 *
 * SAFETY: `default_transaction_read_only = on` before any query, `statement_timeout`, SELECT only,
 * connection closed in `finally`.
 */
import { createRequire } from "module";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);
const { Client } = require("pg");
const { isTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const json = process.argv.includes("--json");
const databaseUrl = resolveReportDbUrl("report-orphaned-order-docs-b1053");
if (!databaseUrl) process.exit(2);

const INVOICE_ORPHAN_CANDIDATES = `
  SELECT i.id, i."tenantId", i.status::text AS status
    FROM "Invoice" i
   WHERE i."orderId" IS NULL
     AND i."recurringInvoiceId" IS NULL
     AND i."feeForPaymentId" IS NULL
     AND i."deliveryBatchId" IS NULL
     AND i."invoiceGroupId" IS NULL
     AND NOT EXISTS (SELECT 1 FROM "Estimate" e WHERE e."invoiceId" = i.id)`;
const TRANSACTION_ORPHANS = `
  SELECT t.id, t."tenantId", t.status::text AS status FROM "Transaction" t WHERE t."orderId" IS NULL`;

const client = new Client({ connectionString: databaseUrl });

async function main() {
  await client.connect();
  await client.query("SET default_transaction_read_only = on");
  await client.query("SET statement_timeout = '45s'");
  const slugs = new Map(
    (await client.query(`SELECT id, slug FROM "Tenant"`)).rows.map((r) => [r.id, r.slug]),
  );
  const out = new Map();
  const bucket = (tenantId) => {
    if (!out.has(tenantId)) {
      const slug = slugs.get(tenantId) ?? null;
      out.set(tenantId, {
        tenant: slug && isTestTenant(slug) ? slug : `live-${out.size + 1}`,
        isTest: Boolean(slug && isTestTenant(slug)),
        invoiceReview: 0,
        transactionSuspect: 0,
        ids: [],
      });
    }
    return out.get(tenantId);
  };
  for (const [sql, field, kind] of [
    [INVOICE_ORPHAN_CANDIDATES, "invoiceReview", "Invoice"],
    [TRANSACTION_ORPHANS, "transactionSuspect", "Transaction"],
  ]) {
    for (const r of (await client.query(sql)).rows) {
      const b = bucket(r.tenantId);
      b[field] += 1;
      if (b.isTest) b.ids.push(`${kind}:${r.id}:${r.status}`);
    }
  }
  const rows = [...out.values()];
  if (json) return console.log(JSON.stringify(rows, null, 2));
  console.log(
    "\n=== ORDER-LESS INVOICES / TRANSACTIONS (B1053) — read-only, counts per tenant ===",
  );
  if (rows.length === 0) console.log("none");
  for (const b of rows) {
    console.log(
      `${b.tenant}: invoices(REVIEW)=${b.invoiceReview} transactions(SUSPECT)=${b.transactionSuspect}`,
    );
    for (const id of b.ids) console.log(`    ${id}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => client.end());
