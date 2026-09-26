// T6 — READ-ONLY identification of the rows the census (t6-null-census.mjs) found with a NULL
// "tenantId": which rows, WHEN they were written, and which tenant their foreign keys say owns them.
// It writes nothing: one READ ONLY transaction, SELECTs only. Output goes to the operator's terminal
// and contains tenant ids and document numbers — do NOT paste it into a public issue or PR.
//
//   railway run --service postgres node C:/ClaudeCode/routeflow/apps/api/scripts/t6-null-rows-report.mjs
//   DATABASE_URL=postgresql://…@localhost:5432/<db> node apps/api/scripts/t6-null-rows-report.mjs --local
//
// For each of the 56 guarded tables with NULL rows it prints id + createdAt (when the table has one).
// StockLot and CreditNote (the two the prod census flagged) additionally print the tenant each FK
// parent carries and whether that answer is UNAMBIGUOUS (exactly one distinct non-null tenant).
// Exit: 0 report printed · 2 env/connection error.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { requireLocalPgConfig } from "./lib/local-pg-config.mjs";
import { redactUrl, resolveDatabaseUrl } from "./lib/railway-db-url.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PART1 = resolve(
  here,
  "../prisma/migrations/20260920220000_t6_tenantid_check_not_valid/migration.sql",
);

/** Per-table detail queries: what the FK parents (and neighbouring rows) say about the owner. */
const DETAIL = {
  StockLot: `SELECT s.id, s."createdAt", s."purchaseDate", s.reference, s."productId",
      p."tenantId" AS product_tenant,
      (SELECT array_agg(DISTINCT m."tenantId") FROM "StockMovement" m
        WHERE m."productId" = s."productId"
          AND abs(extract(epoch FROM (m."createdAt" - s."createdAt"))) < 5) AS nearby_movement_tenants,
      (SELECT array_agg(DISTINCT m.type::text) FROM "StockMovement" m
        WHERE m."productId" = s."productId"
          AND abs(extract(epoch FROM (m."createdAt" - s."createdAt"))) < 5) AS nearby_movement_types
    FROM "StockLot" s LEFT JOIN "Product" p ON p.id = s."productId"
    WHERE s."tenantId" IS NULL ORDER BY s."createdAt"`,
  CreditNote: `SELECT c.id, c."createdAt", c.status::text AS status, c."creditNoteNumber", c."customerId",
      cu."tenantId" AS customer_tenant, c."invoiceId", i."tenantId" AS invoice_tenant,
      (SELECT array_agg(DISTINCT ci."tenantId") FROM "CreditNoteItem" ci WHERE ci."creditNoteId" = c.id) AS item_tenants
    FROM "CreditNote" c LEFT JOIN "Customer" cu ON cu.id = c."customerId"
      LEFT JOIN "Invoice" i ON i.id = c."invoiceId"
    WHERE c."tenantId" IS NULL ORDER BY c."createdAt"`,
};

/** The distinct non-null tenants any *_tenant column of a row names. */
function verdict(row) {
  const tenants = new Set();
  for (const [k, v] of Object.entries(row)) {
    if (!/tenant/i.test(k) || v == null) continue;
    for (const t of Array.isArray(v) ? v : [v]) if (t) tenants.add(t);
  }
  if (tenants.size === 1) return `UNAMBIGUOUS -> ${[...tenants][0]}`;
  return tenants.size === 0 ? "NO OWNER DERIVABLE" : `AMBIGUOUS (${tenants.size} tenants)`;
}

async function main() {
  const local = process.argv.includes("--local");
  let url;
  let localCfg = null; // --local: the vetted explicit fields are the ones dialled
  try {
    url = local ? process.env.DATABASE_URL : resolveDatabaseUrl(process.env);
    if (!url) throw new Error("--local requires DATABASE_URL");
    if (local) {
      localCfg = requireLocalPgConfig(url);
    }
  } catch (e) {
    console.error(`t6-null-rows-report: ${e.message}`);
    return 2;
  }
  const tables = [
    ...readFileSync(PART1, "utf8").matchAll(
      /^ALTER TABLE "(\w+)" ADD CONSTRAINT "\1_tenantId_nn"/gm,
    ),
  ].map((m) => m[1]);
  console.log(
    `t6-null-rows-report: target ${redactUrl(url)} (READ ONLY; contains tenant ids: keep off public issues)`,
  );
  const client = new pg.Client(localCfg ?? { connectionString: url });
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    let any = false;
    for (const t of tables) {
      const { rows: c } = await client.query(
        `SELECT count(*)::int AS n FROM "${t}" WHERE "tenantId" IS NULL`,
      );
      if (c[0].n === 0) continue;
      any = true;
      console.log(`\n== ${t}: ${c[0].n} NULL-tenant row(s)`);
      let rows;
      if (DETAIL[t]) {
        ({ rows } = await client.query(DETAIL[t]));
      } else {
        const hasCreated = (
          await client.query(
            `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'createdAt'`,
            [t],
          )
        ).rowCount;
        ({ rows } = await client.query(
          `SELECT id${hasCreated ? ', "createdAt"' : ""} FROM "${t}" WHERE "tenantId" IS NULL ORDER BY 1 LIMIT 200`,
        ));
      }
      for (const r of rows) {
        console.log(JSON.stringify({ ...r, ...(DETAIL[t] ? { verdict: verdict(r) } : {}) }));
      }
    }
    await client.query("ROLLBACK");
    if (!any) console.log("t6-null-rows-report: no NULL tenantId rows in any of the 56 tables");
    return 0;
  } catch (e) {
    console.error(`t6-null-rows-report: ${e.message}`);
    return 2;
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
