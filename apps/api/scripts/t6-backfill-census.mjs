// T6 — READ-ONLY census of the 19 tables that still need a tenantId BACKFILL (they are NOT in the
// 56-table guard migration). Counts only: no row content, no ids. It answers "is there anything to
// backfill?" before anyone writes a backfill: a table with 0 NULL rows needs none.
//
//   railway run --service postgres node C:/ClaudeCode/routeflow/apps/api/scripts/t6-backfill-census.mjs
//   DATABASE_URL=postgresql://…@localhost:5432/<db> node apps/api/scripts/t6-backfill-census.mjs --local
//   add --json for machine-readable output
//
// Exit: 0 census printed (regardless of the counts) · 2 env/connection error.
// One READ ONLY transaction; every statement is `SELECT count(*)`.
import { pathToFileURL } from "node:url";
import pg from "pg";
import { requireLocalPgConfig } from "./lib/local-pg-config.mjs";
import { redactUrl, resolveDatabaseUrl } from "./lib/railway-db-url.mjs";

/** The 19 models the T6 audit left out of the guard migration because their writers were unproven. */
export const BACKFILL_TABLES = [
  "UserPreference",
  "DeviceToken",
  "PurchaseOrderItem",
  "StockAlert",
  "RouteCustomer",
  "DeliveryBatch",
  "CustomerTagAssignment",
  "CustomerPrice",
  "ReplenishmentSnooze",
  "CommissionAccrual",
  "CommissionAdjustment",
  "Transaction",
  "TransactionItem",
  "Payment",
  "RecurringInvoice",
  "RecurringInvoiceItem",
  "MessageOptOut",
  "InboundTriage",
  "AiUsageEvent",
];

async function main() {
  const local = process.argv.includes("--local");
  const asJson = process.argv.includes("--json");
  let url;
  let localCfg = null; // --local: the explicit fields that were vetted are the ones dialled
  try {
    url = local ? process.env.DATABASE_URL : resolveDatabaseUrl(process.env);
    if (!url) throw new Error("--local requires DATABASE_URL");
    if (local) {
      localCfg = requireLocalPgConfig(url);
    }
  } catch (e) {
    console.error(`t6-backfill-census: ${e.message}`);
    return 2;
  }
  const client = new pg.Client(localCfg ?? { connectionString: url });
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    const rows = [];
    for (const t of BACKFILL_TABLES) {
      const { rows: r } = await client.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE "tenantId" IS NULL)::int AS null_rows FROM "${t}"`,
      );
      rows.push({ table: t, total: r[0].total, nullTenantId: r[0].null_rows });
    }
    await client.query("ROLLBACK");
    if (asJson) {
      console.log(JSON.stringify({ target: redactUrl(url), tables: rows }, null, 2));
    } else {
      console.log(`t6-backfill-census: target ${redactUrl(url)} — ${rows.length} tables`);
      console.log("table".padEnd(26) + "total".padStart(10) + "NULL tenantId".padStart(16));
      for (const r of rows) {
        console.log(
          r.table.padEnd(26) + String(r.total).padStart(10) + String(r.nullTenantId).padStart(16),
        );
      }
      const need = rows.filter((r) => r.nullTenantId > 0);
      console.log(
        need.length === 0
          ? "t6-backfill-census: 0 NULL tenantId rows in all 19 tables — no backfill needed"
          : `t6-backfill-census: ${need.length} table(s) have NULL rows: ${need.map((r) => `${r.table}=${r.nullTenantId}`).join(", ")}`,
      );
    }
    return 0;
  } catch (e) {
    console.error(`t6-backfill-census: ${e.message}`);
    return 2;
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
