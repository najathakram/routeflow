/**
 * READ-ONLY count for B861 / SA-274 Q4: how many tenants have ALREADY saved a Document-numbering
 * card row (a `NumberingSequence` row at `year = 0`). Before B861 that row was never read by live
 * minting; after it, a saved INVOICE/ESTIMATE/CREDIT_NOTE row becomes that document type's live
 * series. So every row this report counts on a live tenant would change that tenant's next number
 * on deploy, and the owner decides what happens to them before the fix merges (activate as saved,
 * or require a fresh save). Count 0 means there is nothing to decide.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The fleet lead runs it under its `railway run`
 * authorization (warn-then-approve):
 *
 *   railway run --service postgres node apps/api/scripts/report-b861-numbering-config.mjs [--json]
 *
 * Output is COUNTS ONLY: no tenant id, slug, name or document number is printed. Test tenants
 * (scripts/lib/test-tenants.cjs) go through the same counting path into a separate `test` block, so
 * a seeded test tenant exercises every column. `--tenant <id>` limits the count to one tenant (the
 * DB-lane pin in numbering-continuity.db.spec.ts uses it; the prod run never passes it).
 *
 * Per document type it reports:
 *   rows            saved year-0 rows on live tenants (the number the owner decides on)
 *   nonDefault      rows whose prefix, next number or padding differs from the card's defaults
 *   perYearDocs     rows whose tenant already has live `<PREFIX>-<year>-####` documents of that type
 *   nextAtOrBelow   rows whose saved next number is at or below an existing document number with the
 *                   saved prefix (after B861 the first live number continues above that document)
 *
 * SAFETY (this script must never be able to touch a client database):
 *   - `default_transaction_read_only = on` is set before any other query runs, so the server itself
 *     rejects a write even if one slipped past review.
 *   - `statement_timeout` caps every query; the connection is closed in `finally`.
 *   - Only SELECT queries appear below; table and column names come from the literal map below.
 */
import { createRequire } from "module";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);
const { Client } = require("pg");
const { isTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const tenantArg = argv.indexOf("--tenant");
const onlyTenant = tenantArg >= 0 ? argv[tenantArg + 1] : null;
if (tenantArg >= 0 && !onlyTenant) {
  console.error("report-b861-numbering-config: --tenant needs a tenant id");
  process.exit(2);
}

// Fail closed BEFORE any connection is attempted (B768 resolver; the redacted target goes to stderr).
const databaseUrl = resolveReportDbUrl("report-b861-numbering-config");
if (!databaseUrl) process.exit(2);

/** The card's defaults (numbering.service.ts DEFAULTS) and each type's document table. */
const TYPES = {
  INVOICE: { prefix: "INV-", padding: 4, table: "Invoice", column: "invoiceNumber" },
  ESTIMATE: { prefix: "EST-", padding: 4, table: "Estimate", column: "estimateNumber" },
  CREDIT_NOTE: { prefix: "CN-", padding: 4, table: "CreditNote", column: "creditNoteNumber" },
};

/** Postgres ARE metacharacters, backslash-escaped — the same set numbering.service.ts escapes. */
const escapeRegex = (s) => String(s ?? "").replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");

const client = new Client({ connectionString: databaseUrl });
const q = async (sql, params) => (await client.query(sql, params)).rows;

async function main() {
  await client.connect();
  await client.query("SET default_transaction_read_only = on");
  await client.query("SET statement_timeout = '45s'");

  const saved = await q(
    `SELECT ns."tenantId", ns."docType"::text AS "docType", ns.prefix, ns."nextNumber", ns.padding,
            t.slug
       FROM "NumberingSequence" ns
       LEFT JOIN "Tenant" t ON t.id = ns."tenantId"
      WHERE ns.year = 0 AND ($1::text IS NULL OR ns."tenantId" = $1)`,
    [onlyTenant],
  );

  const emptyBlock = () =>
    Object.fromEntries(
      [...Object.keys(TYPES), "PAYMENT"].map((docType) => [
        docType,
        { rows: 0, nonDefault: 0, perYearDocs: 0, nextAtOrBelow: 0 },
      ]),
    );
  const live = emptyBlock();
  const test = emptyBlock();
  const liveTenants = new Set();

  for (const row of saved) {
    const isTest = Boolean(row.slug && isTestTenant(row.slug));
    const bucket = (isTest ? test : live)[row.docType];
    if (!bucket) continue; // RETURN/ORDER never carry a year-0 row today; not on the card either way
    bucket.rows++;
    const spec = TYPES[row.docType];
    if (!spec) continue; // PAYMENT: counted for information only (dropped from the card, SA-274 Q6)
    if (!isTest) liveTenants.add(row.tenantId);
    if (row.prefix !== spec.prefix || row.nextNumber !== 1 || row.padding !== spec.padding) {
      bucket.nonDefault++;
    }
    const [{ n }] = await q(
      `SELECT COUNT(*)::int AS n FROM "${spec.table}"
        WHERE "tenantId" = $1 AND "${spec.column}" ~ $2`,
      [row.tenantId, `^${escapeRegex(spec.prefix)}[0-9]{4}-[0-9]+`],
    );
    if (n > 0) bucket.perYearDocs++;
    const [{ max }] = await q(
      `SELECT COALESCE(MAX((regexp_match("${spec.column}", $2))[1]::int), 0)::int AS max
         FROM "${spec.table}" WHERE "tenantId" = $1`,
      [row.tenantId, `^${escapeRegex(row.prefix)}0*(\\d{1,9})(?:-R\\d+)?$`],
    );
    if (max >= row.nextNumber) bucket.nextAtOrBelow++;
  }

  const count = Object.keys(TYPES).reduce((sum, t) => sum + live[t].rows, 0);
  const result = { count, liveTenants: liveTenants.size, byType: live, test };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log("\n=== B861 — saved Document-numbering card rows (year 0) — COUNTS ONLY ===");
  console.log("    session is READ ONLY; no writes are possible\n");
  console.log("docType       rows  nonDefault  perYearDocs  nextAtOrBelow  testTenantRows");
  for (const [docType, b] of Object.entries(live)) {
    const label = docType === "PAYMENT" ? "PAYMENT*" : docType;
    console.log(
      `${label.padEnd(12)} ${String(b.rows).padStart(5)} ${String(b.nonDefault).padStart(11)} ` +
        `${String(b.perYearDocs).padStart(12)} ${String(b.nextAtOrBelow).padStart(14)} ` +
        `${String(test[docType].rows).padStart(15)}`,
    );
  }
  console.log(
    "  * PAYMENT is informational: the card drops it (SA-274 Q6); payments never read it.\n",
  );
  console.log(
    `COUNT (INVOICE+ESTIMATE+CREDIT_NOTE rows on live tenants) = ${count} across ${liveTenants.size} tenant(s)`,
  );
  console.log(
    count === 0
      ? "VERDICT: nothing to decide — no live tenant has a saved row that B861 would activate."
      : "VERDICT: owner decides before merge — activate these rows as saved, or require a fresh save (SA recommends a fresh save).",
  );
}

main()
  .catch((e) => {
    console.error(`report-b861-numbering-config: ${e.message}`);
    process.exitCode = 1;
  })
  .finally(() => client.end().catch(() => {}));
