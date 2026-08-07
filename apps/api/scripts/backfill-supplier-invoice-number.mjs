// Backfill VendorBill.supplierInvoiceNumber from the legacy notes phrase.
//
// WHY: duplicate detection for re-scanned supplier invoices keys on the
// supplierInvoiceNumber column. Bills written before that column existed carry
// the supplier's number only inside `notes` ("Supplier invoice #X" / "Batch
// import — Supplier invoice #X"). Until they're backfilled the matcher has to
// fall back to the fuzzy notes scan, which needs a total AND a date to run.
//
// SAFETY: read-mostly. Fills NULLs only, never overwrites a set value, touches
// no other column (notes included), and only where the phrase parses. Same regex
// + normalization as DuplicateMatchService (uppercase, whitespace stripped) so
// the column agrees with what the app would have written — enforced at startup
// against that service's source, not just asserted in this comment. Idempotent —
// a second run finds nothing. Dry-run by default; pass --execute to write.
//
// Runs across ALL tenants by design: this is a one-shot column backfill for
// legacy rows, not a tenant-scoped operation, so the test-tenant guard does not
// apply. Take a backup first and read the dry-run's tenant count before writing.
//
// Run (dry-run):  railway run --service postgres node apps/api/scripts/backfill-supplier-invoice-number.mjs
// Run (write):    railway run --service postgres node apps/api/scripts/backfill-supplier-invoice-number.mjs --execute
import { readFile } from "node:fs/promises";
import pg from "pg";

const EXECUTE = process.argv.includes("--execute");
const BATCH = 500;

const e = process.env;
const railwayParts = [
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_DB",
  "RAILWAY_TCP_PROXY_DOMAIN",
  "RAILWAY_TCP_PROXY_PORT",
];
const connectionString =
  e.DATABASE_URL ||
  (railwayParts.every((k) => e[k])
    ? `postgresql://${e.POSTGRES_USER}:${encodeURIComponent(e.POSTGRES_PASSWORD)}` +
      `@${e.RAILWAY_TCP_PROXY_DOMAIN}:${e.RAILWAY_TCP_PROXY_PORT}/${e.POSTGRES_DB}`
    : null);

if (!connectionString) {
  console.error(
    `Missing DATABASE_URL (or ${railwayParts.join(", ")}).\n` +
      "Run via:  railway run --service postgres node apps/api/scripts/backfill-supplier-invoice-number.mjs [--execute]",
  );
  process.exit(1);
}

const SUPPLIER_INVOICE_NOTE_RE = /supplier invoice #\s*(\S+)/i;
const normalize = (raw) => (raw ?? "").toUpperCase().replace(/\s+/g, "");

// A backfill that normalizes differently from the matcher writes values the
// matcher will never look up — silently useless. Both literals must therefore
// appear verbatim in the service; the check is skipped (with a warning) only
// where the TS source isn't on disk, so a source-less host can't be a reason for
// the whole script to abort.
const assertInSyncWithService = async () => {
  const url = new URL("../src/import/duplicate-match.service.ts", import.meta.url);
  let src;
  try {
    src = await readFile(url, "utf8");
  } catch {
    console.warn("WARN: duplicate-match.service.ts unreadable here — drift check skipped.\n");
    return;
  }
  const normalizeBody = normalize.toString().split("=>")[1].trim();
  const drifted = [
    ["parse regex", SUPPLIER_INVOICE_NOTE_RE.toString()],
    ["normalize", normalizeBody],
  ].filter(([, snippet]) => !src.includes(snippet));
  if (drifted.length) {
    console.error(
      `ABORT: ${drifted.map(([what]) => what).join(" + ")} no longer matches ` +
        "DuplicateMatchService. Re-sync this script with duplicate-match.service.ts first.",
    );
    process.exit(2);
  }
};

// Every stored number is expected to be normalized already. Counted before and
// after the write so a row denormalized by some other writer can't abort a run,
// while any row THIS script denormalizes rolls the whole batch back.
const DENORMALIZED_COUNT = `SELECT COUNT(*)::int AS n FROM "VendorBill"
   WHERE "supplierInvoiceNumber" IS NOT NULL
     AND "supplierInvoiceNumber" <> upper(regexp_replace("supplierInvoiceNumber", '\\s', '', 'g'))`;

await assertInSyncWithService();

const client = new pg.Client({ connectionString });

try {
  await client.connect();
  console.log(EXECUTE ? "MODE: EXECUTE (will write)\n" : "MODE: dry-run (no writes)\n");

  const { rows } = await client.query(
    `SELECT id, "tenantId", notes FROM "VendorBill"
     WHERE "supplierInvoiceNumber" IS NULL AND notes IS NOT NULL
     ORDER BY id`,
  );
  console.log(`Candidate rows (NULL column, notes present): ${rows.length}`);

  const updates = [];
  for (const row of rows) {
    const match = row.notes.match(SUPPLIER_INVOICE_NOTE_RE);
    if (!match) continue;
    const number = normalize(match[1]);
    if (number) updates.push({ id: row.id, tenantId: row.tenantId, number });
  }
  const tenants = new Set(updates.map((u) => u.tenantId ?? "(null)")).size;
  console.log(
    `Parseable: ${updates.length} across ${tenants} tenant(s), ` +
      `unparseable (left NULL): ${rows.length - updates.length}`,
  );

  const denormalizedBefore = (await client.query(DENORMALIZED_COUNT)).rows[0].n;
  console.log(`Already-stored values that are not normalized: ${denormalizedBefore}`);

  if (!EXECUTE) {
    console.log(
      `\nDry-run: would set supplierInvoiceNumber on ${updates.length} bill(s), writing these ` +
        `normalized values (first 5): ${updates
          .slice(0, 5)
          .map((u) => u.number)
          .join(", ")}\nRe-run with --execute to apply.`,
    );
  } else {
    await client.query("BEGIN");
    let written = 0;
    for (let i = 0; i < updates.length; i += BATCH) {
      const slice = updates.slice(i, i + BATCH);
      // VendorBill.id is TEXT (Prisma String @id), not a uuid column — casting the
      // parameters to ::uuid leaves Postgres with no text = uuid operator.
      const values = slice.map((_, n) => `($${n * 2 + 1}::text, $${n * 2 + 2}::text)`).join(", ");
      const params = slice.flatMap((u) => [u.id, u.number]);
      const res = await client.query(
        `UPDATE "VendorBill" b SET "supplierInvoiceNumber" = v.number
         FROM (VALUES ${values}) AS v(id, number)
         WHERE b.id = v.id AND b."supplierInvoiceNumber" IS NULL`,
        params,
      );
      written += res.rowCount ?? 0;
      console.log(`  batch ${i / BATCH + 1}: ${res.rowCount ?? 0} row(s)`);
    }

    const denormalizedAfter = (await client.query(DENORMALIZED_COUNT)).rows[0].n;
    if (denormalizedAfter > denormalizedBefore) {
      await client.query("ROLLBACK");
      console.error(
        `ROLLED BACK: wrote ${denormalizedAfter - denormalizedBefore} non-normalized value(s).`,
      );
      process.exitCode = 2;
    } else {
      await client.query("COMMIT");
      const remaining = (
        await client.query(
          `SELECT COUNT(*)::int AS n FROM "VendorBill"
           WHERE "supplierInvoiceNumber" IS NULL AND notes ILIKE '%supplier invoice #%'`,
        )
      ).rows[0].n;
      console.log(`\nUpdated: ${written}. Still NULL with a parseable-looking note: ${remaining}`);
      console.log("Backfill complete.");
    }
  }
} finally {
  await client.end();
}
