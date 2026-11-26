/**
 * READ-ONLY count report (Ops W-1449, SA-1526 section 4): import data missing its business link.
 *
 * WHAT IT COUNTS. Whether any past tenantless (super-admin, no business open) import left rows behind:
 *   1. rows with no business (tenantId IS NULL) on the import-touched tables: Product, Supplier,
 *      Customer, Expense, ProductAlias, MigrationJob, VendorBill. (ProductAlias and MigrationJob
 *      declare tenantId NOT NULL, so they are expected to read 0; they are counted anyway so the
 *      answer is evidence, not an assumption.)
 *   2. Customers flagged supplierOnly that have zero orders, as a total plus a per-business count
 *      keyed by an opaque rank (business #1, #2, ...); any with no business are listed apart.
 * If any count is above 0, the cleanup is its own ruling, backup first, dry-run first.
 *
 * Counts only. Never prints a slug, name, id or row content.
 *
 * SAFETY: one `BEGIN READ ONLY` transaction (the server refuses any write), statement_timeout
 * capped, rolled back and closed in `finally`. Only SELECT text exists in this file.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The lead runs it once, on the owner's per-command yes:
 *
 *   railway run --service postgres node apps/api/scripts/report-import-orphan-tenant-link.mjs
 *
 * Options: --json, --help. Exit 0 on success, 2 on refusal.
 */
import { createRequire } from "module";
import { maskHost, toOpaqueBuckets, formatBuckets } from "./lib/count-report-shared.mjs";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const { Client } = createRequire(import.meta.url)("pg");

const NAME = "report-import-orphan-tenant-link";

const HELP = [
  `${NAME} (READ ONLY, counts only)`,
  "Counts import data missing its business link (SA-1526 section 4): rows with no business on",
  "Product, Supplier, Customer, Expense, ProductAlias, MigrationJob, VendorBill, and customers flagged",
  "supplier-only with zero orders (total plus a per-business count keyed by an opaque rank).",
  "No names, ids or rows are printed. Needs the database connection in the environment (Railway",
  "proxy variables or the usual URL); refuses without it.",
  "Usage: node apps/api/scripts/report-import-orphan-tenant-link.mjs [--json]",
].join("\n");

let json = false;
for (const a of process.argv.slice(2)) {
  if (a === "--help" || a === "-h") {
    console.log(HELP);
    process.exit(0);
  } else if (a === "--json") json = true;
  else {
    console.error(`${NAME}: unknown argument ${a} (counts only; see --help)`);
    process.exit(2);
  }
}

// Shared resolver (B768). Its own log line carries the user name, so it is silenced; only the masked host is printed.
const databaseUrl = resolveReportDbUrl(NAME, { log: () => {} });
if (!databaseUrl) {
  console.error(`${NAME}: refusing to run, no database connection is set in the environment`);
  process.exit(2);
}
console.error(`${NAME}: target ${maskHost(databaseUrl)} (READ ONLY)`);

// Fixed list, never from argv.
const NO_BUSINESS_TABLES = [
  "Product",
  "Supplier",
  "Customer",
  "Expense",
  "ProductAlias",
  "MigrationJob",
  "VendorBill",
];

const SUPPLIER_ONLY_SQL = `
  SELECT c."tenantId" AS "tenantId", COUNT(*)::int AS n
    FROM "Customer" c
   WHERE c."supplierOnly" = true
     AND NOT EXISTS (SELECT 1 FROM "Order" o WHERE o."customerId" = c.id)
   GROUP BY c."tenantId"`;

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '45s'");
    const noBusiness = {};
    for (const table of NO_BUSINESS_TABLES) {
      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM "${table}" WHERE "tenantId" IS NULL`,
      );
      noBusiness[table] = Number(rows[0].n);
    }
    const { rows: soRows } = await client.query(SUPPLIER_ONLY_SQL);
    await client.query("ROLLBACK");

    const noBusinessTotal = Object.values(noBusiness).reduce((a, b) => a + b, 0);
    const supplierOnly = toOpaqueBuckets(soRows);
    const supplierOnlyTotal =
      supplierOnly.noBusiness + supplierOnly.perBusiness.reduce((a, b) => a + b.count, 0);
    if (json) {
      console.log(
        JSON.stringify(
          {
            noBusiness,
            noBusinessTotal,
            supplierOnlyZeroOrders: { total: supplierOnlyTotal, ...supplierOnly },
          },
          null,
          2,
        ),
      );
    } else {
      console.log(
        "\n=== Import rows missing a business link (SA-1526 s4) - READ ONLY, counts only ===",
      );
      console.log(`  rows with no business, total: ${noBusinessTotal}`);
      for (const table of NO_BUSINESS_TABLES) console.log(`    ${table}: ${noBusiness[table]}`);
      console.log(`  supplier-only customers with zero orders, total: ${supplierOnlyTotal}`);
      console.log(formatBuckets("per business", supplierOnly));
    }
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error(`${NAME}: failed (${e && e.code ? e.code : "error"}); nothing was written`);
  process.exit(1);
});
