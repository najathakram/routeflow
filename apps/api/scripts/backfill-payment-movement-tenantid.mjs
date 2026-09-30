// Backfill NULL tenantId on InvoicePayment / StockMovement from their parent rows.
//
// WHY: same root cause as backfill-invoiceitem-tenantid.mjs — payments and stock
// movements are created as Prisma NESTED writes, which bypass the tenant
// extension's data.tenantId injection (see prisma.service.ts `forTenant()`).
// forTenant() injects `where.tenantId` on reads, so a NULL-tenantId child row is
// INVISIBLE to every tenant-scoped query: payments vanish from AR / cash-basis
// aggregations and movements vanish from stock and costing history, under-counting
// both. As of 2026-08-21 production carries 10 such rows, all created 2026-04-30
// (3 InvoicePayment + 7 StockMovement).
//
// SAFETY: fills NULLs only, deriving strictly from the parent row
// (InvoicePayment ← Invoice, StockMovement ← Product), and only where the parent's
// own tenantId is non-null. Never overwrites a non-null value, never deletes,
// never touches any other column. Aborts before writing if any existing child row
// contradicts the derivation rule. Dry-run by default; --execute writes inside one
// transaction that rolls back unless the result matches the dry-run prediction.
//
// RLS note: the tenant_isolation policy (apply-rls.js) has an escape hatch for an
// empty `app.current_tenant_id`, which is what a fresh connection has. This script
// sets it to '' explicitly so the NULL rows stay visible rather than being
// silently filtered out.
//
// Run (dry-run):  railway run --service postgres node apps/api/scripts/backfill-payment-movement-tenantid.mjs
// Run (write):    railway run --service postgres node apps/api/scripts/backfill-payment-movement-tenantid.mjs --execute
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
      "Run via:  railway run --service postgres node apps/api/scripts/backfill-payment-movement-tenantid.mjs [--execute]",
  );
  process.exit(1);
}

const client = new pg.Client({
  connectionString:
    `postgresql://${e.POSTGRES_USER}:${encodeURIComponent(e.POSTGRES_PASSWORD)}` +
    `@${e.RAILWAY_TCP_PROXY_DOMAIN}:${e.RAILWAY_TCP_PROXY_PORT}/${e.POSTGRES_DB}`,
});

const rows = async (sql) => (await client.query(sql)).rows;
const count = async (sql) => (await client.query(sql)).rows[0].n;
const day = (d) => new Date(d).toISOString().slice(0, 10);

// Ask the question via the PARENT, the way demo-verify.js's tenant-scoping check
// does: a NULL child row is only repairable if its parent carries a tenant.
const NULL_PAYMENTS = `FROM "InvoicePayment" p JOIN "Invoice" i ON i.id = p."invoiceId" WHERE p."tenantId" IS NULL`;
const NULL_MOVEMENTS = `FROM "StockMovement" s JOIN "Product" pr ON pr.id = s."productId" WHERE s."tenantId" IS NULL`;

const PAYMENT_MISMATCHES = `SELECT COUNT(*)::int AS n FROM "InvoicePayment" p JOIN "Invoice" i ON i.id = p."invoiceId"
   WHERE p."tenantId" IS NOT NULL AND i."tenantId" IS NOT NULL AND p."tenantId" <> i."tenantId"`;
const MOVEMENT_MISMATCHES = `SELECT COUNT(*)::int AS n FROM "StockMovement" s JOIN "Product" pr ON pr.id = s."productId"
   WHERE s."tenantId" IS NOT NULL AND pr."tenantId" IS NOT NULL AND s."tenantId" <> pr."tenantId"`;

try {
  await client.connect();
  await client.query(`SELECT set_config('app.current_tenant_id', '', false)`);
  console.log(`Target: ${e.RAILWAY_TCP_PROXY_DOMAIN}:${e.RAILWAY_TCP_PROXY_PORT}/${e.POSTGRES_DB}`);
  console.log(EXECUTE ? "MODE: EXECUTE (will write)\n" : "MODE: dry-run (no writes)\n");

  const before = {
    nullPayments: await count(
      `SELECT COUNT(*)::int AS n FROM "InvoicePayment" WHERE "tenantId" IS NULL`,
    ),
    derivablePayments: await count(
      `SELECT COUNT(*)::int AS n ${NULL_PAYMENTS} AND i."tenantId" IS NOT NULL`,
    ),
    nullMovements: await count(
      `SELECT COUNT(*)::int AS n FROM "StockMovement" WHERE "tenantId" IS NULL`,
    ),
    derivableMovements: await count(
      `SELECT COUNT(*)::int AS n ${NULL_MOVEMENTS} AND pr."tenantId" IS NOT NULL`,
    ),
    paymentMismatches: await count(PAYMENT_MISMATCHES),
    movementMismatches: await count(MOVEMENT_MISMATCHES),
  };
  console.log("Before:", before);

  // A NULL child whose parent row is missing entirely. Both columns are FK-backed
  // so this must be 0; if it is not, the JOINs above are hiding rows.
  const parentlessPayments =
    before.nullPayments - (await count(`SELECT COUNT(*)::int AS n ${NULL_PAYMENTS}`));
  const parentlessMovements =
    before.nullMovements - (await count(`SELECT COUNT(*)::int AS n ${NULL_MOVEMENTS}`));
  if (parentlessPayments || parentlessMovements) {
    console.log(
      `⚠ NULL rows with no parent row: ${parentlessPayments} payment(s), ` +
        `${parentlessMovements} movement(s) — not repairable from a parent.`,
    );
  }

  if (before.paymentMismatches > 0 || before.movementMismatches > 0) {
    console.error("ABORT: existing child/parent tenant mismatches — derivation rule unsafe here.");
    process.exit(2);
  }

  const payments = await rows(
    `SELECT p.id, i."invoiceNumber", i."tenantId" AS derived, p."createdAt"
     ${NULL_PAYMENTS} ORDER BY p."createdAt", p.id LIMIT 200`,
  );
  const movements = await rows(
    `SELECT s.id, s.type, pr.name AS product, pr."tenantId" AS derived, s."createdAt"
     ${NULL_MOVEMENTS} ORDER BY s."createdAt", s.id LIMIT 200`,
  );
  console.log(`\nInvoicePayment rows to fill (${payments.length} shown, cap 200):`);
  for (const r of payments) {
    const to = r.derived ?? "SKIP — parent tenantId is NULL";
    console.log(`  ${r.id}  invoice ${r.invoiceNumber}  → ${to}  [${day(r.createdAt)}]`);
  }
  console.log(`\nStockMovement rows to fill (${movements.length} shown, cap 200):`);
  for (const r of movements) {
    const to = r.derived ?? "SKIP — parent tenantId is NULL";
    console.log(`  ${r.id}  ${r.type} on "${r.product}"  → ${to}  [${day(r.createdAt)}]`);
  }

  const byTenant = await rows(
    `SELECT derived AS "tenantId", t.name AS tenant,
            COUNT(*) FILTER (WHERE kind = 'payment')::int AS payments,
            COUNT(*) FILTER (WHERE kind = 'movement')::int AS movements
     FROM (
       SELECT 'payment' AS kind, i."tenantId" AS derived ${NULL_PAYMENTS} AND i."tenantId" IS NOT NULL
       UNION ALL
       SELECT 'movement' AS kind, pr."tenantId" AS derived ${NULL_MOVEMENTS} AND pr."tenantId" IS NOT NULL
     ) x
     LEFT JOIN "Tenant" t ON t.id = x.derived
     GROUP BY derived, t.name ORDER BY derived`,
  );
  console.log("\nPer-tenant effect:");
  for (const r of byTenant) {
    console.log(
      `  ${r.tenantId} (${r.tenant ?? "?"}): +${r.payments} payment(s), +${r.movements} movement(s)`,
    );
  }

  if (!EXECUTE) {
    console.log(
      `\nDry-run: would set tenantId on ${before.derivablePayments} InvoicePayment row(s) and ` +
        `${before.derivableMovements} StockMovement row(s). ` +
        `${before.nullPayments - before.derivablePayments} payment(s) and ` +
        `${before.nullMovements - before.derivableMovements} movement(s) would stay NULL ` +
        `(parent has no tenant). Re-run with --execute to apply.`,
    );
    process.exit(0);
  }

  await client.query("BEGIN");
  const paid = await client.query(
    `UPDATE "InvoicePayment" p SET "tenantId" = i."tenantId"
     FROM "Invoice" i
     WHERE i.id = p."invoiceId" AND p."tenantId" IS NULL AND i."tenantId" IS NOT NULL`,
  );
  const moved = await client.query(
    `UPDATE "StockMovement" s SET "tenantId" = pr."tenantId"
     FROM "Product" pr
     WHERE pr.id = s."productId" AND s."tenantId" IS NULL AND pr."tenantId" IS NOT NULL`,
  );
  const after = {
    nullPayments: await count(
      `SELECT COUNT(*)::int AS n FROM "InvoicePayment" WHERE "tenantId" IS NULL`,
    ),
    nullMovements: await count(
      `SELECT COUNT(*)::int AS n FROM "StockMovement" WHERE "tenantId" IS NULL`,
    ),
    paymentMismatches: await count(PAYMENT_MISMATCHES),
    movementMismatches: await count(MOVEMENT_MISMATCHES),
  };
  const expected = {
    payments: before.derivablePayments,
    movements: before.derivableMovements,
    nullPayments: before.nullPayments - before.derivablePayments,
    nullMovements: before.nullMovements - before.derivableMovements,
  };
  if (
    after.paymentMismatches > 0 ||
    after.movementMismatches > 0 ||
    paid.rowCount !== expected.payments ||
    moved.rowCount !== expected.movements ||
    after.nullPayments !== expected.nullPayments ||
    after.nullMovements !== expected.nullMovements
  ) {
    await client.query("ROLLBACK");
    console.error("ROLLED BACK: result did not match the dry-run prediction", {
      updated: { payments: paid.rowCount, movements: moved.rowCount },
      expected,
      after,
    });
    process.exit(2);
  }
  await client.query("COMMIT");
  console.log(`\nUpdated payments: ${paid.rowCount}, movements: ${moved.rowCount}`);
  console.log("After:", after);
  console.log("\n✅ Backfill complete.");
} finally {
  await client.end();
}
