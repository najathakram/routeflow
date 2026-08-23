/**
 * report-receiving-unit-drift.mjs
 *
 * READ-ONLY diagnostic for the receiving box→piece conversion bug (see
 * .claude/pipeline/plans/2026-08-23-receiving-box-conversion.md). Stock is
 * denominated in PIECES system-wide, but `InventoryService.recordPurchase`
 * and `InventoryService.receivePurchaseOrder` wrote the operator's raw
 * entered number (which they meant as BOXES) straight into
 * `Product.currentStock` / `StockMovement.quantity` / `StockLot.qty` with no
 * ×unitsPerBox conversion — so every affected receipt under-counted by a
 * factor of `unitsPerBox` and on-hand drifted hugely negative over time.
 *
 * For each product with `unitsPerBox > 1`, this script reconstructs what
 * on-hand would be if every recorded PURCHASE `StockMovement.quantity` had
 * actually meant BOXES (i.e. the true received pieces = as-stored quantity ×
 * unitsPerBox), and cross-checks that hypothesis against the product's
 * current stock and its lifetime invoiced (piece) sales. It prints suspected
 * under-received products with a proposed correction and a LOW/MED/HIGH
 * confidence — nothing here is applied. A repair (if the owner wants one) is
 * a separate, reviewed, dedicated script — same posture as
 * `repair-costing.mjs` next to this file.
 *
 * NEVER writes anything — there is deliberately no --execute flag. Wired
 * below (imported, never invoked) is `assertTestTenant`: if a write/repair
 * mode is ever added to a script descended from this one, CLAUDE.md's
 * test-tenant policy requires it call that guard before touching any live
 * row — see `assertWriteGuardForFutureUse` below.
 *
 * ⚠️ ACCURACY NOTE — re-run AFTER the WP1 code fix deploys: once
 * `recordPurchase`/`receivePurchaseOrder` convert explicitly-boxed payloads
 * up front (WP1), a NEW boxed receive already stores the correct, large
 * piece count in `StockMovement.quantity` — re-multiplying that by
 * unitsPerBox here would be a false positive, not a fix. Set
 * REPORT_RECEIVED_BEFORE to the WP1 deploy timestamp (see below) once that
 * ships so only pre-fix history is reinterpreted.
 *
 * Run locally (DATABASE_URL from your env / docker-compose):
 *   node apps/api/scripts/report-receiving-unit-drift.mjs
 * Run against prod via the Railway postgres proxy:
 *   railway run --service postgres node apps/api/scripts/report-receiving-unit-drift.mjs
 *
 * Optional env:
 *   REPORT_TENANT_SLUG=<slug>        Scope to one tenant (default: all ACTIVE tenants).
 *   REPORT_RECEIVED_BEFORE=<ISO date> Only reinterpret PURCHASE movements created before
 *                                     this date (set to the WP1 deploy time once it ships;
 *                                     default: no bound — everything is examined).
 *
 * Never names a live tenant anywhere in this file — tenants are addressed only via the
 * REPORT_TENANT_SLUG env var at runtime, exactly like `order-invoice-divergence-report.mjs`
 * and `repair-costing.mjs`.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { assertTestTenant } from "../../../scripts/lib/test-tenants.cjs";

// ─── Connection ───────────────────────────────────────────────────────────────
// Mirrors prod-migrate.mjs / tidy-regulated-categories.mjs: `railway run
// --service postgres` does not set DATABASE_URL — the postgres service only
// exposes credential PARTS (POSTGRES_* + the public TCP proxy host/port) — so
// build the URL from those when DATABASE_URL itself isn't set. A directly-set
// DATABASE_URL (local docker-compose, CI) always wins.
function resolveDbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
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
      `\nMissing env: ${missing.join(", ")}\n` +
        "Set DATABASE_URL, or run via: railway run --service postgres node apps/api/scripts/report-receiving-unit-drift.mjs\n",
    );
    process.exit(1);
  }
  return (
    `postgresql://${e.POSTGRES_USER}:${encodeURIComponent(e.POSTGRES_PASSWORD)}` +
    `@${e.RAILWAY_TCP_PROXY_DOMAIN}:${e.RAILWAY_TCP_PROXY_PORT}/${e.POSTGRES_DB}`
  );
}

const pool = new Pool({ connectionString: resolveDbUrl() });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ─── Test-tenant guard, pre-wired for a future write branch ──────────────────
// This report has NO write branch today (no --execute). If one is ever added
// (to actually apply a receiving correction), CLAUDE.md's "Test tenants &
// real-client data" policy requires it call assertTestTenant before touching
// a single row — exactly like every other tenant-scoped write path in the
// repo. Defined here, unused by the read-only flow below, so that
// requirement is impossible to miss when that branch gets written.
function assertWriteGuardForFutureUse(tenantSlug) {
  return assertTestTenant(tenantSlug, "report-receiving-unit-drift (future write mode)");
}
void assertWriteGuardForFutureUse;

// ─── Scope ────────────────────────────────────────────────────────────────────
const slug = process.env.REPORT_TENANT_SLUG || null;
const receivedBefore = process.env.REPORT_RECEIVED_BEFORE || null;

const money = (n) => (n == null ? "—" : `$${Number(n).toFixed(2)}`);
const qty = (n) => (n == null ? "—" : Number(n).toFixed(3));

// ─── Confidence heuristic ──────────────────────────────────────────────────────
// Three independent signals, computed per boxed product from data this script
// can actually see. None of this is certain — it is a hypothesis for the
// owner to review against the movement history before acting on it.
//
//   A. negativeStock       — currentStock is negative (direct, observable proof
//                             something under-counted; the "-1627.00 BOX" symptom).
//   B. boxHypothesisHeals  — reinterpreting every PURCHASE quantity as BOXES
//                             (×unitsPerBox) brings stock back to >= 0. Confirms
//                             the box-conversion bug specifically, not just "some"
//                             stock problem.
//   C. soldExceedsReceived — lifetime invoiced (piece) sales exceed the
//                             AS-STORED purchase total. Suspicious even when
//                             stock hasn't gone negative (opening balances or
//                             manual ADJUSTMENTs can mask it for a while).
//   D. purchasesLookBoxy   — every PURCHASE movement, on average, recorded FEWER
//                             pieces than a single box holds — a near-impossible
//                             piece quantity for a routine restock, but a normal
//                             box count. Weak/behavioral, not evidence of drift.
//
// HIGH: A && B   — negative stock, and the box hypothesis explains it cleanly.
// MED:  (A && !B) || C — negative stock the hypothesis doesn't fully resolve
//       (something else may also be wrong), OR positive stock but more was
//       sold than was ever officially received.
// LOW:  !A && !C && D — no direct stock/sales evidence, only the behavioral
//       tell that purchase quantities look like box counts, not piece counts.
// (none of the above) — not surfaced; nothing suspicious found.
function classify({
  stockNow,
  correctedStockIfBoxed,
  soldPieces,
  purchasedAsStored,
  avgPurchaseQty,
  unitsPerBox,
}) {
  const A = stockNow < 0;
  const B = correctedStockIfBoxed >= 0;
  const C = soldPieces > purchasedAsStored;
  const D = avgPurchaseQty > 0 && avgPurchaseQty < unitsPerBox;

  if (A && B) return { level: "HIGH", signals: { A, B, C, D } };
  if ((A && !B) || C) return { level: "MED", signals: { A, B, C, D } };
  if (!A && !C && D) return { level: "LOW", signals: { A, B, C, D } };
  return { level: null, signals: { A, B, C, D } };
}

async function analyzeTenant(tenant) {
  const products = await prisma.product.findMany({
    where: { tenantId: tenant.id, unitsPerBox: { gt: 1 } },
    select: {
      id: true,
      name: true,
      sku: true,
      unit: true,
      unitsPerBox: true,
      currentStock: true,
      averageCost: true,
      isActive: true,
    },
    orderBy: { name: "asc" },
  });
  if (products.length === 0) return { tenant, findings: [], noPurchaseHistory: [] };

  const productIds = products.map((p) => p.id);

  // PURCHASE movements as currently stored (the potentially buggy raw numbers).
  // Scoped by productId ONLY, never by StockMovement.tenantId: that column is
  // nullable and NULL-tenantId movement rows are a known production condition
  // (see scripts/backfill-payment-movement-tenantid.mjs) — filtering on it would
  // silently drop real purchases, which here means inventing drift that is not
  // there. The product ids above are already tenant-scoped, and a movement's
  // tenant is exactly its product's tenant (the same derivation that backfill uses).
  const movementWhere = {
    productId: { in: productIds },
    type: "PURCHASE",
  };
  if (receivedBefore) movementWhere.createdAt = { lt: new Date(receivedBefore) };
  const purchases = await prisma.stockMovement.findMany({
    where: movementWhere,
    select: { productId: true, quantity: true },
  });
  const purchaseAgg = new Map(); // productId -> { sum, count }
  for (const m of purchases) {
    const cur = purchaseAgg.get(m.productId) ?? { sum: 0, count: 0 };
    cur.sum += Number(m.quantity);
    cur.count += 1;
    purchaseAgg.set(m.productId, cur);
  }

  // Lifetime invoiced (piece) sales. Queried THROUGH Invoice, never top-level
  // invoiceItem.findMany — invoice lines are nested writes and can carry
  // tenantId = null, which a direct `where: { tenantId }` on InvoiceItem would
  // silently drop (see common/invoiced-sales.ts). Same REAL_INVOICE_STATUSES
  // filter that helper uses (DRAFT/VOID/WRITTEN_OFF excluded).
  const invoices = await prisma.invoice.findMany({
    where: { tenantId: tenant.id, status: { notIn: ["DRAFT", "VOID", "WRITTEN_OFF"] } },
    select: {
      items: {
        where: { productId: { in: productIds } },
        select: { productId: true, qty: true },
      },
    },
  });
  const soldAgg = new Map(); // productId -> sum
  for (const inv of invoices) {
    for (const item of inv.items ?? []) {
      if (!item.productId) continue;
      soldAgg.set(item.productId, (soldAgg.get(item.productId) ?? 0) + Number(item.qty));
    }
  }

  const findings = [];
  const noPurchaseHistory = [];

  for (const p of products) {
    const unitsPerBox = Number(p.unitsPerBox);
    const stockNow = Number(p.currentStock);
    const purchase = purchaseAgg.get(p.id);

    if (!purchase || purchase.sum <= 0) {
      // Nothing to reinterpret as boxes — a negative-stock product with zero
      // purchase history has a different cause (out of scope for this report).
      if (stockNow < 0) noPurchaseHistory.push({ product: p, stockNow });
      continue;
    }

    const purchasedAsStored = purchase.sum;
    const purchasedIfBoxed = purchasedAsStored * unitsPerBox;
    const underReceivedPieces = purchasedIfBoxed - purchasedAsStored;
    const correctedStockIfBoxed = stockNow + underReceivedPieces;
    const soldPieces = soldAgg.get(p.id) ?? 0;
    const avgPurchaseQty = purchasedAsStored / purchase.count;

    const { level, signals } = classify({
      stockNow,
      correctedStockIfBoxed,
      soldPieces,
      purchasedAsStored,
      avgPurchaseQty,
      unitsPerBox,
    });
    if (!level) continue;

    findings.push({
      product: p,
      unitsPerBox,
      stockNow,
      purchaseCount: purchase.count,
      purchasedAsStored,
      purchasedIfBoxed,
      underReceivedPieces,
      correctedStockIfBoxed,
      soldPieces,
      avgPurchaseQty,
      level,
      signals,
    });
  }

  // HIGH first, then MED, then LOW; stable by name within a tier.
  const order = { HIGH: 0, MED: 1, LOW: 2 };
  findings.sort(
    (a, b) => order[a.level] - order[b.level] || a.product.name.localeCompare(b.product.name),
  );

  return { tenant, findings, noPurchaseHistory };
}

(async () => {
  const tenants = await prisma.tenant.findMany({
    where: slug ? { slug } : { status: "ACTIVE" },
    select: { id: true, slug: true, status: true },
    orderBy: { slug: "asc" },
  });

  console.log(`\n===== RECEIVING UNIT-DRIFT REPORT (read-only) =====`);
  console.log(`Scope: ${slug ? `tenant ${slug}` : "all ACTIVE tenants"}`);
  if (receivedBefore)
    console.log(`PURCHASE movements reinterpreted only if created before ${receivedBefore}`);
  console.log(`Tenants scanned: ${tenants.length}\n`);

  const totals = { HIGH: 0, MED: 0, LOW: 0 };

  for (const tenant of tenants) {
    const { findings, noPurchaseHistory } = await analyzeTenant(tenant);
    if (findings.length === 0 && noPurchaseHistory.length === 0) continue;

    console.log(`\n──────────────────────────────────────────────────────────`);
    console.log(`Tenant: ${tenant.slug}  (${findings.length} suspect product(s))`);

    for (const f of findings) {
      totals[f.level] += 1;
      const p = f.product;
      console.log(
        `\n  [${f.level}] ${p.name}${p.sku ? ` (${p.sku})` : ""}${p.isActive ? "" : " [inactive]"} — box of ${f.unitsPerBox}`,
      );
      console.log(
        `    On-hand now: ${qty(f.stockNow)} (displayed as "${qty(f.stockNow)} ${p.unit}" — piece count, box-noun label bug)`,
      );
      console.log(
        `    PURCHASE history: ${f.purchaseCount} movement(s), ${qty(f.purchasedAsStored)} as stored`,
      );
      console.log(
        `    If those were BOXES: ${qty(f.purchasedAsStored)} × ${f.unitsPerBox} = ${qty(f.purchasedIfBoxed)} pieces` +
          ` (under-received by ${qty(f.underReceivedPieces)} pieces)`,
      );
      console.log(`    Lifetime invoiced sales: ${qty(f.soldPieces)} pieces`);
      console.log(
        `    Signals: negativeStock=${f.signals.A} boxHypothesisHeals=${f.signals.B} ` +
          `soldExceedsReceived=${f.signals.C} purchasesLookBoxy=${f.signals.D}`,
      );
      console.log(
        `    Proposed correction: convert the ${f.purchaseCount} PURCHASE movement(s) above from` +
          ` pieces-as-stored to boxes → on-hand ${qty(f.stockNow)} → ${qty(f.correctedStockIfBoxed)} pieces` +
          ` (avg cost ${money(p.averageCost)}/pc would also need re-deriving from the corrected quantities —` +
          ` not computed here).`,
      );
    }

    if (noPurchaseHistory.length > 0) {
      console.log(
        `\n  Negative stock but ZERO purchase history (different cause — out of scope here):`,
      );
      for (const n of noPurchaseHistory) {
        console.log(
          `    ${n.product.name}: ${qty(n.stockNow)} on hand, no PURCHASE movements recorded`,
        );
      }
    }
  }

  console.log(`\n──────────────────────────────────────────────────────────`);
  console.log(`Totals: HIGH ${totals.HIGH}  MED ${totals.MED}  LOW ${totals.LOW}`);
  console.log(`\nDecision guide:`);
  console.log(
    `  • HIGH — negative on-hand that the box-conversion hypothesis alone resolves to >= 0.`,
  );
  console.log(
    `    Strongest signature of this specific bug; review the listed PURCHASE movements first.`,
  );
  console.log(
    `  • MED — either negative stock the hypothesis doesn't fully explain (something else may`,
  );
  console.log(
    `    also be wrong — check for RETURN/WRITE_OFF/ADJUSTMENT movements too), or stock hasn't`,
  );
  console.log(`    gone negative yet but more has been sold than was ever officially received.`);
  console.log(
    `  • LOW — no direct stock/sales evidence; only that every recorded PURCHASE quantity is`,
  );
  console.log(`    smaller than one box, which is unusual for a genuine piece-quantity restock.`);
  console.log(
    `  • A manual ADJUSTMENT already applied to patch a product's stock will change its actual`,
  );
  console.log(
    `    drift independent of this heuristic — check the movement history before acting.`,
  );
  console.log(
    `  • This script proposes nothing automatically and writes nothing. A repair (if wanted)`,
  );
  console.log(`    is its own reviewed script, run only after a fresh backup — same posture as`);
  console.log(`    repair-costing.mjs next to this file.`);
  console.log(`\n(READ-ONLY — nothing was modified.)\n`);

  await prisma.$disconnect();
  await pool.end();
})().catch(async (err) => {
  console.error("ERR:", err.message);
  await prisma.$disconnect().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(1);
});
