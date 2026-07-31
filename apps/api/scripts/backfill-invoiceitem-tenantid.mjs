// Backfill NULL tenantId on Invoice / InvoiceItem from their parent rows.
//
// WHY: invoice lines are created as Prisma NESTED writes, which bypass the tenant
// extension's data.tenantId injection. The May-2026 bulk import left ~3.4k
// InvoiceItem rows (85% of all lines) and 3 Invoice rows with tenantId = NULL.
// forTenant() injects `where.tenantId` on reads, so those rows are INVISIBLE to
// every tenant-scoped invoiceItem query — which under-counts tobacco sales
// reports and disables per-product case/unit splitting on imported history.
//
// SAFETY: fills NULLs only, deriving from the parent row (Invoice ← Customer,
// InvoiceItem ← Invoice). Verified before writing: zero existing rows contradict
// the derivation (no item.tenantId <> parent invoice.tenantId anywhere).
// Dry-run by default; pass --execute to write. Single transaction, aborts on any
// remaining inconsistency.
//
// Run (dry-run):  railway run --service postgres node apps/api/scripts/backfill-invoiceitem-tenantid.mjs
// Run (write):    railway run --service postgres node apps/api/scripts/backfill-invoiceitem-tenantid.mjs --execute
import pg from "pg";

const EXECUTE = process.argv.includes("--execute");

const e = process.env;
const need = [
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_DB",
  "RAILWAY_TCP_PROXY_DOMAIN",
  "RAILWAY_TCP_PROXY_PORT",
];
const missing = need.filter((k) => !e[k]);
if (missing.length) {
  console.error(
    `Missing env: ${missing.join(", ")}\n` +
      "Run via:  railway run --service postgres node apps/api/scripts/backfill-invoiceitem-tenantid.mjs [--execute]",
  );
  process.exit(1);
}

const client = new pg.Client({
  connectionString:
    `postgresql://${e.POSTGRES_USER}:${encodeURIComponent(e.POSTGRES_PASSWORD)}` +
    `@${e.RAILWAY_TCP_PROXY_DOMAIN}:${e.RAILWAY_TCP_PROXY_PORT}/${e.POSTGRES_DB}`,
});

const one = async (sql) => (await client.query(sql)).rows[0];

try {
  await client.connect();
  console.log(`Target: ${e.RAILWAY_TCP_PROXY_DOMAIN}:${e.RAILWAY_TCP_PROXY_PORT}/${e.POSTGRES_DB}`);
  console.log(EXECUTE ? "MODE: EXECUTE (will write)\n" : "MODE: dry-run (no writes)\n");

  const before = {
    nullInvoices: (await one(`SELECT COUNT(*)::int AS n FROM "Invoice" WHERE "tenantId" IS NULL`))
      .n,
    derivableInvoices: (
      await one(
        `SELECT COUNT(*)::int AS n FROM "Invoice" i JOIN "Customer" c ON c.id = i."customerId"
         WHERE i."tenantId" IS NULL AND c."tenantId" IS NOT NULL`,
      )
    ).n,
    nullItems: (await one(`SELECT COUNT(*)::int AS n FROM "InvoiceItem" WHERE "tenantId" IS NULL`))
      .n,
    mismatches: (
      await one(
        `SELECT COUNT(*)::int AS n FROM "InvoiceItem" ii JOIN "Invoice" i ON i.id = ii."invoiceId"
         WHERE ii."tenantId" IS NOT NULL AND i."tenantId" IS NOT NULL AND ii."tenantId" <> i."tenantId"`,
      )
    ).n,
  };
  console.log("Before:", before);

  if (before.mismatches > 0) {
    console.error("ABORT: existing item/parent tenant mismatches — derivation rule unsafe here.");
    process.exit(2);
  }
  if (!EXECUTE) {
    console.log(
      `\nDry-run: would set tenantId on ${before.derivableInvoices} invoice(s), then on the ` +
        `NULL items whose parent has a tenant. Re-run with --execute to apply.`,
    );
    process.exit(0);
  }

  await client.query("BEGIN");
  const inv = await client.query(
    `UPDATE "Invoice" i SET "tenantId" = c."tenantId"
     FROM "Customer" c
     WHERE c.id = i."customerId" AND i."tenantId" IS NULL AND c."tenantId" IS NOT NULL`,
  );
  const items = await client.query(
    `UPDATE "InvoiceItem" ii SET "tenantId" = i."tenantId"
     FROM "Invoice" i
     WHERE i.id = ii."invoiceId" AND ii."tenantId" IS NULL AND i."tenantId" IS NOT NULL`,
  );
  const after = {
    nullInvoices: (await one(`SELECT COUNT(*)::int AS n FROM "Invoice" WHERE "tenantId" IS NULL`))
      .n,
    nullItems: (await one(`SELECT COUNT(*)::int AS n FROM "InvoiceItem" WHERE "tenantId" IS NULL`))
      .n,
    mismatches: (
      await one(
        `SELECT COUNT(*)::int AS n FROM "InvoiceItem" ii JOIN "Invoice" i ON i.id = ii."invoiceId"
         WHERE ii."tenantId" IS NOT NULL AND i."tenantId" IS NOT NULL AND ii."tenantId" <> i."tenantId"`,
      )
    ).n,
  };
  if (after.mismatches > 0) {
    await client.query("ROLLBACK");
    console.error("ROLLED BACK: backfill produced mismatches", after);
    process.exit(2);
  }
  await client.query("COMMIT");
  console.log(`Updated invoices: ${inv.rowCount}, items: ${items.rowCount}`);
  console.log("After:", after);
  console.log("\n✅ Backfill complete.");
} finally {
  await client.end();
}
