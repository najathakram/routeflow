/**
 * f07-conservation-report.mjs — READ-ONLY forensic report for campaign batch F07's
 * historical damage (D4 repair-as-we-go, 2026-09-01).
 *
 * Reports the two classes of damage the F07 code fix stops creating:
 *
 *   B64 — cancelling an order never returned its creation-time stock decrement.
 *         Candidate set: CANCELLED orders holding ≥1 line item that is NOT
 *         item-status CANCELLED and carries a productId. (After F07 every cancel
 *         flips its surviving lines to CANCELLED, so this set is closed — it can
 *         only shrink from here, never grow.)
 *
 *         ⚠️ PER-ROW TRUTH IS NOT MECHANICALLY DECIDABLE, and this script does
 *         not pretend otherwise. An order created as DRAFT and later promoted
 *         never had a creation-time decrement (promotion touches no stock), and
 *         an order cancelled straight out of DRAFT never had one either. Nothing
 *         persisted distinguishes those from a genuinely-decremented order once
 *         the status reads CANCELLED: OrderRevision records EDITs only, there are
 *         no StockMovement rows on this path (create() tracks currentStock alone),
 *         and status transitions are not audited. Crediting a promoted draft would
 *         INVENT inventory — strictly worse than the understatement it "fixes".
 *         So this script quantifies the UPPER BOUND per product and per tenant and
 *         stops there. It performs no writes and emits no repair SQL. The class is
 *         recorded as unrepairable-without-owner-input.
 *
 *   B56 — cancelling a PARTIALLY_DELIVERED/DELIVERED order voided the invoice for
 *         goods the customer already had. Identified set: non-DRAFT VOID invoices
 *         on CANCELLED orders whose lines carry deliveredQty > 0.
 *
 *         ⚠️ REPORT ONLY — un-voiding is not a row patch. A void released
 *         invoicedQty, returned wallet credits, reversed regulated-ledger rows and
 *         clawed back commission accruals; undoing it means re-running four
 *         subsystems' business logic, not flipping a status column. The right
 *         remedy per row is an operator decision (re-invoice the delivered
 *         quantity, or accept the write-off), so this prints the evidence an
 *         operator needs and leaves the decision to a human.
 *
 * SAFETY MODEL
 *   • SELECT-only. The session is forced `default_transaction_read_only = on`
 *     before any query, mirroring scripts/data-integrity-report.mjs. There is no
 *     --execute flag anywhere in this file, by design.
 *   • Prints ids, quantities, amounts, statuses and dates ONLY — never customer,
 *     product or business names, emails or addresses.
 *   • Writes its findings to local-assets/f07-conservation-report-<ts>.jsonl
 *     (gitignored) so the owner review has an artifact.
 *
 * Usage (production, read-only):
 *   railway run --service postgres node scripts/f07-conservation-report.mjs
 *   railway run --service postgres node scripts/f07-conservation-report.mjs --tenant <tenantId>
 *
 * Connection resolution mirrors scripts/data-integrity-report.mjs.
 */
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) {
    console.error(`${name} requires an argument`);
    process.exit(2);
  }
  return v;
}
const ONLY_TENANT = flagValue("--tenant");

function resolveConnectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const {
    POSTGRES_USER,
    POSTGRES_PASSWORD,
    POSTGRES_DB,
    RAILWAY_TCP_PROXY_DOMAIN,
    RAILWAY_TCP_PROXY_PORT,
  } = process.env;
  if (POSTGRES_PASSWORD && RAILWAY_TCP_PROXY_DOMAIN && RAILWAY_TCP_PROXY_PORT) {
    return `postgresql://${POSTGRES_USER ?? "postgres"}:${POSTGRES_PASSWORD}@${RAILWAY_TCP_PROXY_DOMAIN}:${RAILWAY_TCP_PROXY_PORT}/${POSTGRES_DB ?? "railway"}`;
  }
  console.error(
    "No connection available. Set DATABASE_URL, or run via `railway run --service postgres`.",
  );
  process.exit(2);
}

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "local-assets");

const n = (v) => Math.round(Number(v ?? 0) * 1000) / 1000;
const money = (v) => Number(Number(v ?? 0).toFixed(2));

async function main() {
  const client = new pg.Client({ connectionString: resolveConnectionString() });
  await client.connect();
  // Belt and braces: the session physically cannot write, whatever follows.
  await client.query("SET default_transaction_read_only = on");

  const { rows: dbRows } = await client.query("SELECT current_database() AS db");
  const findings = [];
  const tenantFilter = ONLY_TENANT ? `AND o."tenantId" = $1` : "";
  const params = ONLY_TENANT ? [ONLY_TENANT] : [];

  console.log(`\nF07 conservation report — database: ${dbRows[0].db}`);
  console.log("READ-ONLY. No repair SQL is emitted by this script.\n");

  // ── B64 · candidate set: CANCELLED orders with surviving (non-CANCELLED) lines ──
  const b64 = await client.query(
    `SELECT o."tenantId", o.id AS "orderId", o."orderNumber", o."createdAt",
            oi.id AS "itemId", oi."productId", oi.status AS "itemStatus",
            oi.qty, COALESCE(oi."deliveredQty", 0) AS "deliveredQty"
       FROM "Order" o
       JOIN "OrderItem" oi ON oi."orderId" = o.id
      WHERE o.status = 'CANCELLED'
        AND oi.status <> 'CANCELLED'
        AND oi."productId" IS NOT NULL
        ${tenantFilter}
      ORDER BY o."tenantId", o."createdAt"`,
    params,
  );

  const byProduct = new Map();
  const b64Orders = new Map();
  for (const r of b64.rows) {
    const upper = Math.max(0, n(r.qty) - n(r.deliveredQty));
    if (upper <= 0) continue;
    const key = `${r.tenantId}::${r.productId}`;
    byProduct.set(key, n((byProduct.get(key) ?? 0) + upper));
    if (!b64Orders.has(r.orderId)) {
      b64Orders.set(r.orderId, {
        tenantId: r.tenantId,
        orderId: r.orderId,
        orderNumber: r.orderNumber,
        createdAt: r.createdAt,
        lines: [],
      });
    }
    b64Orders.get(r.orderId).lines.push({
      itemId: r.itemId,
      productId: r.productId,
      itemStatus: r.itemStatus,
      qty: n(r.qty),
      deliveredQty: n(r.deliveredQty),
      upperBoundCredit: upper,
    });
  }

  console.log("── B64 · stock never returned by a pre-F07 cancel ──────────────────");
  console.log(`Candidate orders: ${b64Orders.size}   Products affected: ${byProduct.size}`);
  console.log(
    "UPPER BOUND only — an unknown share of these were promoted or cancelled DRAFTs that",
  );
  console.log("never had a creation-time decrement. DO NOT credit these blindly.\n");
  for (const [key, qty] of [...byProduct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    const [tenantId, productId] = key.split("::");
    console.log(`  tenant ${tenantId}  product ${productId}  upper-bound understatement: ${qty}`);
  }
  if (byProduct.size > 40) console.log(`  … ${byProduct.size - 40} more product rows in the JSONL`);

  for (const o of b64Orders.values()) {
    findings.push({ class: "B64", verdict: "unrepairable-without-owner-input", ...o });
  }

  // ── B56 · invoices voided on cancels of already-delivered goods ────────────────
  const b56 = await client.query(
    `SELECT o."tenantId", o.id AS "orderId", o."orderNumber",
            i.id AS "invoiceId", i."invoiceNumber", i.total, i."issueDate",
            SUM(COALESCE(oi."deliveredQty", 0)) AS "deliveredUnits"
       FROM "Order" o
       JOIN "Invoice" i ON i."orderId" = o.id
       JOIN "OrderItem" oi ON oi."orderId" = o.id
      WHERE o.status = 'CANCELLED'
        AND i.status = 'VOID'
        ${tenantFilter}
      GROUP BY o."tenantId", o.id, o."orderNumber", i.id, i."invoiceNumber", i.total, i."issueDate"
     HAVING SUM(COALESCE(oi."deliveredQty", 0)) > 0
      ORDER BY i."issueDate"`,
    params,
  );

  console.log("\n── B56 · invoices voided for goods already delivered ───────────────");
  console.log(`Affected invoices: ${b56.rows.length}`);
  console.log("REPORT ONLY — un-voiding re-runs four subsystems; the remedy is an operator");
  console.log("decision per row (re-invoice the delivered qty, or accept the write-off).\n");
  let lost = 0;
  for (const r of b56.rows) {
    lost = money(lost + Number(r.total));
    console.log(
      `  tenant ${r.tenantId}  order ${r.orderNumber}  invoice ${r.invoiceNumber}  ` +
        `total ${money(r.total)}  deliveredUnits ${n(r.deliveredUnits)}`,
    );
    findings.push({
      class: "B56",
      verdict: "owner-decision-required",
      tenantId: r.tenantId,
      orderId: r.orderId,
      orderNumber: r.orderNumber,
      invoiceId: r.invoiceId,
      invoiceNumber: r.invoiceNumber,
      total: money(r.total),
      deliveredUnits: n(r.deliveredUnits),
      issueDate: r.issueDate,
    });
  }
  console.log(`\n  Revenue voided against delivered goods: ${lost}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `f07-conservation-report-${stamp}.jsonl`);
  fs.writeFileSync(out, findings.map((f) => JSON.stringify(f)).join("\n") + "\n", "utf8");
  console.log(`\nWrote ${findings.length} findings to ${out}`);

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
