/**
 * repair-f10-reopen-damage.mjs — D4 repair flight for campaign batch F10
 * (bugs B55 and B54, shipped in the F10 PR).
 *
 * ⚠️ SCOPE IS DERIVED, NOT HARDCODED — and deliberately narrow. The only rows
 * this script will ever consider are StockMovement rows matching EXACTLY:
 *
 *     type = 'SALE' AND quantity > 0 AND reference LIKE 'Reopen stop %'
 *
 * Those rows are the complete, unambiguous footprint of B55: before the F10 fix,
 * reopenStop wrote one such compensating movement per DELIVERED/PARTIAL delivery
 * mutation and incremented Product.currentStock by the same quantity — reversing
 * a decrement that never happened. Nothing else in the codebase writes a positive
 * SALE movement (verified repo-wide at df1ef9a3: the only two
 * `stockMovement.create({type:"SALE"})` call sites were both inside reopenStop,
 * and order creation decrements currentStock with NO movement row at all), so
 * these rows cannot collide with legitimate inventory history.
 *
 * WHAT IS REPAIRED (B55 — inventory inflation)
 *   Per affected product: currentStock is decremented by the sum of its reopen
 *   movement quantities, and each movement row is annotated (notes) as reversed
 *   by this flight. The movement rows are NOT deleted — they are the audit trail
 *   of both the original defect and this repair.
 *
 * WHAT IS ONLY REPORTED (B54 — stranded paid invoices)
 *   The same rows carry `reference = 'Reopen stop <stopId>'`, which is the only
 *   historical trail of pre-fix reopens. For each distinct stop the script
 *   resolves the stop's orders and lists any invoice in PAID/PARTIAL or carrying
 *   a confirmed (status='PAID') InvoicePayment. Those are B54's stranded-money
 *   cases. This script NEVER mutates money: the payment really was collected, so
 *   whether the order state, the invoice, or neither is wrong is a per-case
 *   business judgment for the owner. They are printed and written to the JSONL
 *   log as `reportOnly: true` findings. (D4: unidentifiable/undecidable damage is
 *   recorded, never guessed.)
 *
 * NOT DETECTABLE, recorded as such: a pre-fix reopen of a stop that had no
 * DELIVERED/PARTIAL delivery mutations wrote no movement row and left no other
 * trace, so it cannot be enumerated retroactively. Going forward the F10 fix
 * writes an AuditLog row (`action = 'route_stop.reopened'`) on every reopen.
 *
 * SAFETY MODEL (house pattern — mirrors scripts/repair-integrity.mjs)
 *   • DRY RUN BY DEFAULT: session forced `default_transaction_read_only = on`;
 *     prints per product current → proposed currentStock and the exact SQL.
 *   • Writing requires ALL of:
 *       --execute                   turn writes on
 *       --i-have-a-fresh-backup     attest a fresh VERIFIED backup exists
 *       --confirm <productId>       opt in EACH product individually (repeatable)
 *                                   (or --confirm-all-listed, which still requires
 *                                    --execute and the backup attestation)
 *   • One transaction per product. Inside it the product row is locked
 *     (SELECT … FOR UPDATE), currentStock is RE-READ and compared to the dry-run
 *     snapshot, and the movement set is re-read; ANY drift aborts that product's
 *     transaction and moves on.
 *   • After each commit the product's remaining un-reversed reopen movements are
 *     re-counted and reported (now clean / still dirty).
 *   • Every executed repair appends to local-assets/f10-repair-<ts>.jsonl.
 *   • Refuses to run unless current_database() is 'railway' or 'routeflow'
 *     — pass --force-nonprod to run elsewhere (loud, deliberate).
 *   • Prints ids, quantities, statuses and dates ONLY — never customer, product,
 *     or business names.
 *
 * Usage:
 *   railway run --service postgres node scripts/repair-f10-reopen-damage.mjs
 *   railway run --service postgres node scripts/repair-f10-reopen-damage.mjs --verbose
 *   railway run --service postgres node scripts/repair-f10-reopen-damage.mjs \
 *     --execute --i-have-a-fresh-backup --confirm <productId>
 */
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const EXECUTE = argv.includes("--execute");
const BACKUP_ATTESTED = argv.includes("--i-have-a-fresh-backup");
const FORCE_NONPROD = argv.includes("--force-nonprod");
const CONFIRM_ALL = argv.includes("--confirm-all-listed");
const VERBOSE = argv.includes("--verbose");

function collectFlag(name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) {
        console.error(`${name} requires an argument`);
        process.exit(2);
      }
      out.push(argv[i + 1]);
    }
  }
  return out;
}
const CONFIRMED = new Set(collectFlag("--confirm"));

// ─── Connection resolution (mirrors scripts/data-integrity-report.mjs) ────────
function resolveUrl() {
  const direct = process.env.DATABASE_URL;
  if (direct && !direct.includes(".railway.internal")) return direct;
  const {
    POSTGRES_USER,
    POSTGRES_PASSWORD,
    POSTGRES_DB,
    RAILWAY_TCP_PROXY_DOMAIN,
    RAILWAY_TCP_PROXY_PORT,
  } = process.env;
  if (RAILWAY_TCP_PROXY_DOMAIN && POSTGRES_USER && POSTGRES_PASSWORD) {
    const db = POSTGRES_DB || "railway";
    const port = RAILWAY_TCP_PROXY_PORT || "5432";
    return `postgresql://${encodeURIComponent(POSTGRES_USER)}:${encodeURIComponent(
      POSTGRES_PASSWORD,
    )}@${RAILWAY_TCP_PROXY_DOMAIN}:${port}/${db}`;
  }
  return direct || null;
}

const url = resolveUrl();
if (!url) {
  console.error(
    "No usable connection string. Set DATABASE_URL, or run via:\n" +
      "  railway run --service postgres node scripts/repair-f10-reopen-damage.mjs",
  );
  process.exit(2);
}

const REOPEN_MOVEMENT_PREDICATE = `
  m.type = 'SALE'
  AND m.quantity > 0
  AND m.reference LIKE 'Reopen stop %'
  AND COALESCE(m.notes, '') NOT LIKE '%[F10-repaired]%'
`;

const client = new pg.Client({ connectionString: url });

function fail(msg) {
  console.error(`\n✖ ${msg}`);
  process.exitCode = 1;
}

async function main() {
  await client.connect();

  const { rows: dbRows } = await client.query("SELECT current_database() AS db");
  const db = dbRows[0].db;
  if (!["railway", "routeflow"].includes(db) && !FORCE_NONPROD) {
    fail(
      `Refusing to run against database "${db}" — expected 'railway' or 'routeflow'. ` +
        `Pass --force-nonprod to override deliberately.`,
    );
    await client.end();
    return;
  }

  if (!EXECUTE) {
    await client.query("SET default_transaction_read_only = on");
  } else if (!BACKUP_ATTESTED) {
    fail("--execute requires --i-have-a-fresh-backup (attest a fresh VERIFIED backup exists).");
    await client.end();
    return;
  }

  console.log(`\nF10 repair flight — database "${db}" — ${EXECUTE ? "EXECUTE" : "DRY RUN"}`);
  console.log("=".repeat(78));

  // ── B55: inventory inflation, grouped per product ──────────────────────────
  const { rows: products } = await client.query(`
    SELECT
      m."productId"                       AS product_id,
      p."tenantId"                        AS tenant_id,
      p."currentStock"                    AS current_stock,
      COUNT(*)::int                       AS movement_count,
      SUM(m.quantity)                     AS inflated_by,
      MIN(m."createdAt")                  AS first_reopen,
      MAX(m."createdAt")                  AS last_reopen
    FROM "StockMovement" m
    JOIN "Product" p ON p.id = m."productId"
    WHERE ${REOPEN_MOVEMENT_PREDICATE}
    GROUP BY m."productId", p."tenantId", p."currentStock"
    ORDER BY SUM(m.quantity) DESC
  `);

  console.log(`\nB55 — inventory inflated by pre-fix reopens: ${products.length} product(s)\n`);
  if (products.length === 0) {
    console.log("  (nothing to repair)");
  }
  for (const r of products) {
    const proposed = Number(r.current_stock) - Number(r.inflated_by);
    console.log(
      `  product ${r.product_id}  tenant ${r.tenant_id}\n` +
        `    ${r.movement_count} reopen movement(s), ${r.first_reopen.toISOString().slice(0, 10)} → ` +
        `${r.last_reopen.toISOString().slice(0, 10)}\n` +
        `    currentStock ${r.current_stock} → ${proposed}   (inflated by ${r.inflated_by})` +
        (proposed < 0 ? "   ⚠ REPAIR WOULD GO NEGATIVE — needs an owner decision, skipped" : ""),
    );
    if (VERBOSE) {
      console.log(
        `    SQL: UPDATE "Product" SET "currentStock" = "currentStock" - ${r.inflated_by} ` +
          `WHERE id = '${r.product_id}';`,
      );
    }
  }

  // ── B54: stranded paid invoices on pre-fix reopened stops (REPORT ONLY) ────
  const { rows: stranded } = await client.query(`
    WITH reopened AS (
      SELECT DISTINCT
        replace(m.reference, 'Reopen stop ', '') AS stop_id,
        MAX(m."createdAt")                       AS reopened_at
      FROM "StockMovement" m
      WHERE m.type = 'SALE' AND m.quantity > 0 AND m.reference LIKE 'Reopen stop %'
      GROUP BY replace(m.reference, 'Reopen stop ', '')
    )
    SELECT
      r.stop_id,
      r.reopened_at,
      o.id                AS order_id,
      o.status            AS order_status,
      i.id                AS invoice_id,
      i.status            AS invoice_status,
      i.total             AS invoice_total,
      (SELECT COUNT(*)::int FROM "InvoicePayment" ip
        WHERE ip."invoiceId" = i.id AND ip.status = 'PAID')   AS confirmed_payments
    FROM reopened r
    JOIN "Order"   o ON o."routeRunStopId" = r.stop_id
    JOIN "Invoice" i ON i."orderId" = o.id
    WHERE i.status IN ('PAID', 'PARTIAL')
       OR EXISTS (
            SELECT 1 FROM "InvoicePayment" ip
            WHERE ip."invoiceId" = i.id AND ip.status = 'PAID'
          )
    ORDER BY r.reopened_at DESC
  `);

  console.log(
    `\nB54 — invoices carrying live money on a pre-fix reopened stop: ` +
      `${stranded.length} (REPORT ONLY — no money is ever mutated by this script)\n`,
  );
  for (const s of stranded) {
    console.log(
      `  stop ${s.stop_id}  reopened ${s.reopened_at.toISOString().slice(0, 10)}\n` +
        `    order ${s.order_id} [${s.order_status}]  invoice ${s.invoice_id} ` +
        `[${s.invoice_status}] total ${s.invoice_total}, ${s.confirmed_payments} confirmed payment(s)`,
    );
  }
  if (stranded.length === 0) console.log("  (none found)");

  console.log(
    `\nNot enumerable: pre-fix reopens of stops with no DELIVERED/PARTIAL mutations wrote no\n` +
      `movement row and left no other trace. Recorded as unrepairable per D4. Reopens after the\n` +
      `F10 deploy are traceable via AuditLog action = 'route_stop.reopened'.`,
  );

  // ── Apply (B55 only) ──────────────────────────────────────────────────────
  if (!EXECUTE) {
    console.log(
      `\nDry run complete. To repair: --execute --i-have-a-fresh-backup --confirm <productId>`,
    );
    await client.end();
    return;
  }

  const logDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "local-assets");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(
    logDir,
    `f10-repair-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
  );
  const append = (entry) => fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");

  append({
    kind: "b54-report-only",
    at: new Date().toISOString(),
    database: db,
    findings: stranded.map((s) => ({
      stopId: s.stop_id,
      reopenedAt: s.reopened_at,
      orderId: s.order_id,
      orderStatus: s.order_status,
      invoiceId: s.invoice_id,
      invoiceStatus: s.invoice_status,
      confirmedPayments: s.confirmed_payments,
    })),
    note: "money never mutated by this script — owner decision per case",
  });

  let repaired = 0;
  let skipped = 0;
  for (const r of products) {
    const id = r.product_id;
    if (!CONFIRM_ALL && !CONFIRMED.has(id)) {
      skipped++;
      continue;
    }
    const proposed = Number(r.current_stock) - Number(r.inflated_by);
    if (proposed < 0) {
      console.log(
        `\n  ⏭ ${id}: repair would drive currentStock negative — skipped (owner decision)`,
      );
      skipped++;
      continue;
    }

    try {
      await client.query("BEGIN");
      const { rows: locked } = await client.query(
        `SELECT "currentStock" FROM "Product" WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (locked.length === 0) throw new Error("product row vanished");
      if (String(locked[0].currentStock) !== String(r.current_stock)) {
        throw new Error(
          `currentStock drifted since the dry run (${r.current_stock} → ${locked[0].currentStock})`,
        );
      }
      const { rows: recheck } = await client.query(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(m.quantity), 0) AS total
           FROM "StockMovement" m
          WHERE m."productId" = $1 AND ${REOPEN_MOVEMENT_PREDICATE}`,
        [id],
      );
      if (recheck[0].n !== r.movement_count || String(recheck[0].total) !== String(r.inflated_by)) {
        throw new Error("reopen movement set drifted since the dry run");
      }

      await client.query(
        `UPDATE "Product" SET "currentStock" = "currentStock" - $2 WHERE id = $1`,
        [id, r.inflated_by],
      );
      await client.query(
        `UPDATE "StockMovement" m
            SET notes = COALESCE(m.notes || ' ', '') || '[F10-repaired]'
          WHERE m."productId" = $1 AND ${REOPEN_MOVEMENT_PREDICATE}`,
        [id],
      );
      await client.query("COMMIT");

      const { rows: after } = await client.query(
        `SELECT p."currentStock" AS stock,
                (SELECT COUNT(*)::int FROM "StockMovement" m
                  WHERE m."productId" = p.id AND ${REOPEN_MOVEMENT_PREDICATE}) AS remaining
           FROM "Product" p WHERE p.id = $1`,
        [id],
      );
      const clean = after[0].remaining === 0;
      console.log(
        `\n  ✓ ${id}: currentStock ${r.current_stock} → ${after[0].stock}; ` +
          `${r.movement_count} movement(s) annotated; re-check ${clean ? "clean" : "STILL DIRTY"}`,
      );
      append({
        kind: "b55-repair",
        at: new Date().toISOString(),
        productId: id,
        tenantId: r.tenant_id,
        before: { currentStock: String(r.current_stock) },
        after: { currentStock: String(after[0].stock) },
        reversedQuantity: String(r.inflated_by),
        movementCount: r.movement_count,
        recheckClean: clean,
      });
      repaired++;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      fail(`${id}: aborted — ${e.message}`);
      append({
        kind: "b55-repair-aborted",
        at: new Date().toISOString(),
        productId: id,
        error: e.message,
      });
      skipped++;
    }
  }

  console.log(`\nRepaired ${repaired} product(s), skipped ${skipped}. Log: ${logPath}`);
  await client.end();
}

main().catch(async (e) => {
  console.error(e);
  await client.end().catch(() => {});
  process.exit(1);
});
