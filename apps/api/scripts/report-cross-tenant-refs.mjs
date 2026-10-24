/**
 * READ-ONLY, COUNTS-ONLY census for 681 (R5-5 tenant-ref sweep, SA-936 MUST 8): how many stored ids already point at a row
 * of ANOTHER tenant (or at nothing), per field. Each count is an existing cross-tenant link; any count > 0 goes to the
 * Senior Architect before the PR lands. This script writes nothing and never prints an id, a slug or a name.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The owner runs it from the PR branch, before each 681 PR merges:
 *
 *   railway run --service postgres node apps/api/scripts/report-cross-tenant-refs.mjs
 *   (add --json for machine-readable output)
 *
 * What it counts, per field:
 *   crossTenant - rows whose own tenantId is set and whose stored id's target row has a DIFFERENT tenantId
 *                 (a target with a NULL tenant counts as different).
 *   noTarget    - ONLY for the bare-string fields (no FK): rows whose stored id matches no target row at all.
 * Plus: RouteRun and RouteRunStop rows with a NULL tenantId (legacy orphans that the new proof will 404 on).
 *
 * SAFETY (this script must never be able to touch a client database destructively):
 *   - `default_transaction_read_only = on` is set on the session before any other query runs, so the server itself
 *     rejects a write even if one slipped past review.
 *   - `statement_timeout` caps every query.
 *   - Only SELECT COUNT(*) queries appear below; identifiers come from the whitelist `FIELDS`, never from argv.
 *   - The connection is closed in `finally`.
 */
import { createRequire } from "module";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const { Client } = createRequire(import.meta.url)("pg");

/**
 * One row per guarded field. `bare: true` = the column has no FK (the id may point at nothing).
 * PR A fields first, then PR B's run / stop fields (census covers both so one run serves both PRs).
 */
export const FIELDS = [
  {
    field: "CustomerPrice.customerId",
    table: "CustomerPrice",
    col: "customerId",
    target: "Customer",
  },
  { field: "CustomerPrice.productId", table: "CustomerPrice", col: "productId", target: "Product" },
  { field: "InvoiceItem.productId", table: "InvoiceItem", col: "productId", target: "Product" },
  { field: "EstimateItem.productId", table: "EstimateItem", col: "productId", target: "Product" },
  { field: "Estimate.customerId", table: "Estimate", col: "customerId", target: "Customer" },
  {
    field: "RecurringInvoice.customerId",
    table: "RecurringInvoice",
    col: "customerId",
    target: "Customer",
  },
  {
    field: "RecurringInvoiceItem.productId",
    table: "RecurringInvoiceItem",
    col: "productId",
    target: "Product",
  },
  {
    field: "PromotionProduct.productId",
    table: "PromotionProduct",
    col: "productId",
    target: "Product",
  },
  {
    field: "ProductMapping.productId",
    table: "ProductMapping",
    col: "productId",
    target: "Product",
  },
  {
    field: "AdvancePayment.customerId",
    table: "AdvancePayment",
    col: "customerId",
    target: "Customer",
  },
  {
    field: "SaleDraft.customerId",
    table: "SaleDraft",
    col: "customerId",
    target: "Customer",
    bare: true,
  },
  {
    field: "Product.trackedCategoryId",
    table: "Product",
    col: "trackedCategoryId",
    target: "TrackedCategory",
  },
  { field: "Order.routeRunId", table: "Order", col: "routeRunId", target: "RouteRun" },
  { field: "Order.routeRunStopId", table: "Order", col: "routeRunStopId", target: "RouteRunStop" },
  { field: "Message.runId", table: "Message", col: "runId", target: "RouteRun", bare: true },
  {
    field: "Return.routeRunStopId",
    table: "Return",
    col: "routeRunStopId",
    target: "RouteRunStop",
    bare: true,
  },
  {
    field: "DriverLocation.runId",
    table: "DriverLocation",
    col: "runId",
    target: "RouteRun",
    bare: true,
  },
];

const NULL_TENANT_TABLES = ["RouteRun", "RouteRunStop"];

export function crossTenantSql({ table, col, target }) {
  return `SELECT COUNT(*)::int AS n
            FROM "${table}" r
            JOIN "${target}" t ON t."id" = r."${col}"
           WHERE r."tenantId" IS NOT NULL
             AND t."tenantId" IS DISTINCT FROM r."tenantId"`;
}

export function noTargetSql({ table, col, target }) {
  return `SELECT COUNT(*)::int AS n
            FROM "${table}" r
            LEFT JOIN "${target}" t ON t."id" = r."${col}"
           WHERE r."${col}" IS NOT NULL
             AND t."id" IS NULL`;
}

export function nullTenantSql(table) {
  return `SELECT COUNT(*)::int AS n FROM "${table}" WHERE "tenantId" IS NULL`;
}

async function main() {
  const json = process.argv.slice(2).includes("--json");
  const databaseUrl = resolveReportDbUrl("report-cross-tenant-refs");
  if (!databaseUrl) process.exit(2);

  const client = new Client({ connectionString: databaseUrl });
  const count = async (sql) => (await client.query(sql)).rows[0].n;

  await client.connect();
  try {
    // Hard read-only guarantee + query cap, before anything else runs.
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '45s'");

    const rows = [];
    for (const spec of FIELDS) {
      const crossTenant = await count(crossTenantSql(spec));
      const noTarget = spec.bare ? await count(noTargetSql(spec)) : null;
      rows.push({ field: spec.field, crossTenant, noTarget });
    }
    const nullTenant = [];
    for (const table of NULL_TENANT_TABLES) {
      nullTenant.push({ table, rows: await count(nullTenantSql(table)) });
    }

    const total =
      rows.reduce((a, r) => a + r.crossTenant + (r.noTarget ?? 0), 0) +
      nullTenant.reduce((a, r) => a + r.rows, 0);

    if (json) {
      console.log(JSON.stringify({ fields: rows, nullTenant, total }, null, 2));
    } else {
      console.log("\n=== CROSS-TENANT REF CENSUS (read-only, counts only) ===\n");
      const w = Math.max(...rows.map((r) => r.field.length));
      console.log(`${"field".padEnd(w)}  crossTenant  noTarget`);
      for (const r of rows) {
        console.log(
          `${r.field.padEnd(w)}  ${String(r.crossTenant).padStart(11)}  ${r.noTarget === null ? "      n/a" : String(r.noTarget).padStart(8)}`,
        );
      }
      console.log("");
      for (const n of nullTenant) console.log(`${n.table} with NULL tenantId: ${n.rows}`);
      console.log(
        `\nTOTAL: ${total}${total > 0 ? "  -> any count > 0 goes to the SA before landing (no cleanup in 681)" : "  (clean)"}\n`,
      );
    }
  } finally {
    await client.end();
  }
}

// Import-safe: the pure SQL builders are exported for the unit spec; main() runs only as a CLI.
const invokedDirectly =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop());
if (invokedDirectly) {
  main().catch((e) => {
    console.error("report-cross-tenant-refs failed:", e?.message ?? e);
    process.exit(1);
  });
}
