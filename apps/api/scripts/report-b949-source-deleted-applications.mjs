// B949 sizing: READ-ONLY, COUNT-ONLY. How many LIVE credit-note applications belong to a credit note whose source invoice
// was DELETED (the SOURCE_DELETED marker, #2848)? The B949 guard makes every path that would RESTORE such an application
// (void invoice, order cancel/delete, unapply, an order-edit untick, a settle shrink) refuse with 409 CREDIT_NOTE_SOURCE_GONE,
// so this is the number of live rows those operations are blocked on until the marked note is voided first.
//
// Output is invoice statuses and integers ONLY: never an id, tenant, customer or amount.
// One READ ONLY transaction, always rolled back; the SQL has no parameters. Safety rests on READ ONLY + ROLLBACK, NOT on a
// target check: it does not refuse a non-local database (the B768 ruling: owner-run reports reach prod through the shared
// resolver on purpose).
//
//   node apps/api/scripts/report-b949-source-deleted-applications.mjs --self-test
//   node apps/api/scripts/report-b949-source-deleted-applications.mjs --print-sql   # no connection: paste into psql
//   node apps/api/scripts/report-b949-source-deleted-applications.mjs               # local compose DB (B768 resolver)
//   railway run --service postgres node apps/api/scripts/report-b949-source-deleted-applications.mjs   # owner-run

import { pathToFileURL } from "node:url";

const TAG = "report-b949";

/** The ONE statement: live CREDIT_NOTE applications of marked notes, by the invoice's status. */
export function buildSql() {
  return [
    `SELECT i."status"::text AS invoice_status,`,
    `       count(*)::int AS applications,`,
    `       count(DISTINCT p."creditNoteId")::int AS notes`,
    `FROM "InvoicePayment" p`,
    `JOIN "Invoice" i ON i."id" = p."invoiceId"`,
    `WHERE p."method" = 'CREDIT_NOTE' AND p."status" <> 'VOID'`,
    `  AND p."creditNoteId" IN (`,
    `    SELECT a."entityId" FROM "AuditLog" a`,
    `    WHERE a."entityType" = 'CreditNote' AND a."action" = 'SOURCE_DELETED' AND a."entityId" IS NOT NULL)`,
    `GROUP BY i."status"`,
    `ORDER BY 1`,
  ].join("\n");
}

/** Refuses anything that is not a single read-only SELECT. */
export function assertReadOnlySql(sql) {
  const body = String(sql).trim().replace(/;\s*$/, "");
  if (body.includes(";")) throw new Error(`${TAG}: refusing multiple statements`);
  if (!/^\s*SELECT\b/i.test(body)) throw new Error(`${TAG}: only a SELECT is allowed`);
  const banned =
    /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|COPY|VACUUM|REINDEX|CALL|DO)\b/i;
  if (banned.test(body.replace(/'[^']*'/g, "''"))) throw new Error(`${TAG}: write keyword refused`);
  return body;
}

/** Invoice statuses and integers only. */
export function formatReport(rows) {
  const lines = ["invoice_status".padEnd(18) + "applications".padStart(14) + "notes".padStart(8)];
  let apps = 0;
  for (const r of rows) {
    lines.push(
      String(r.invoice_status).padEnd(18) +
        String(r.applications).padStart(14) +
        String(r.notes).padStart(8),
    );
    apps += Number(r.applications);
  }
  lines.push(
    "",
    `${apps} live application(s) of SOURCE_DELETED credit notes (${rows.length} invoice status group(s))`,
    "Each is an application the B949 guard refuses to RESTORE until its credit note is voided first.",
  );
  return lines.join("\n");
}

function selfTest() {
  assertReadOnlySql(buildSql());
  for (const bad of ['DELETE FROM "User"', "SELECT 1; SELECT 2", 'UPDATE "User" SET a = 1']) {
    let refused = false;
    try {
      assertReadOnlySql(bad);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error(`self-test: ${bad} was not refused`);
  }
  console.log(`${TAG} self-test: OK (one read-only SELECT)`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) return selfTest();
  if (args.includes("--print-sql")) {
    console.log(`${assertReadOnlySql(buildSql())};`);
    return;
  }
  // B768: owner-run read-only reports reach the database through the ONE shared resolver.
  const { resolveReportDbUrl } = await import("./lib/report-db-url.mjs");
  const url = resolveReportDbUrl(TAG);
  if (!url) {
    console.error(`${TAG}: no usable database URL: refusing to run`);
    process.exit(2);
  }
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL default_transaction_read_only = on");
    await client.query("SET LOCAL statement_timeout = '60s'");
    console.log(formatReport((await client.query(assertReadOnlySql(buildSql()))).rows));
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(`${TAG}: ${e.message}`);
    process.exit(1);
  });
}
