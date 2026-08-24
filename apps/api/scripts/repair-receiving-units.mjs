/**
 * REPAIR: convert box-entered PURCHASE movements to pieces — HIGH-signature only.
 *
 * The pre-#417 receiving paths (Quick Restock, PO receive) stored the operator's
 * raw entered number, so a "boxes" entry under-received stock by unitsPerBox and
 * the entered unit cost (per BOX) was stored as if per PIECE. This script repairs
 * the recorded history for products matching the report's HIGH signature ONLY:
 *
 *     unitsPerBox > 1
 *     AND currentStock < 0
 *     AND converting EVERY PURCHASE movement (qty × unitsPerBox) heals
 *         on-hand to >= 0
 *
 * That is the unambiguous fingerprint of this bug (owner decision 2026-08-23:
 * HIGH first; MED/LOW require case-by-case review of actual restocking habits).
 *
 * Per selected product, in ONE transaction:
 *   1. Each PURCHASE StockMovement: quantity ×= unitsPerBox, unitCost ÷= unitsPerBox
 *      (4-dp), and a note is appended recording the original values.
 *   2. Matching StockLots (same product, qty == old movement qty, unitCost == old
 *      movement unitCost): qty and remainingQty ×= unitsPerBox, unitCost ÷= unitsPerBox.
 *      Lots are matched conservatively — an ambiguous match is reported and skipped.
 *   3. Product.currentStock += Σ(newQty − oldQty).
 *   4. avgCostAfter/stockAfter snapshots and Product.averageCost are NOT touched
 *      here — after executing, re-derive them with the SHIPPED replay:
 *      POST /inventory/recompute-costs { "productIds": [ …printed below… ] }
 *      (an authenticated OPERATOR call; the script prints the exact body).
 *
 * SAFETY (per CLAUDE.md live-tenant policy):
 *   - DRY-RUN by default: prints the full plan, writes nothing.
 *   - Executing requires:  --execute --confirm-tenant=<slug>   (slug typed back)
 *   - A LIVE (non-test) tenant additionally requires  --live-tenant-override
 *     and this script must only ever run at the tenant's / owner's explicit
 *     request, AFTER a fresh validated backup.
 *
 * Run:
 *   railway run --service postgres node apps/api/scripts/repair-receiving-units.mjs --tenant=<slug>
 *   …review the dry-run…
 *   railway run --service postgres node apps/api/scripts/repair-receiving-units.mjs \
 *     --tenant=<slug> --execute --confirm-tenant=<slug> [--live-tenant-override]
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { isTestTenant } from "../../../scripts/lib/test-tenants.cjs";

// ─── Connection (mirrors report-receiving-unit-drift.mjs) ────────────────────
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
        "Set DATABASE_URL, or run via: railway run --service postgres node apps/api/scripts/repair-receiving-units.mjs\n",
    );
    process.exit(1);
  }
  return (
    `postgresql://${e.POSTGRES_USER}:${encodeURIComponent(e.POSTGRES_PASSWORD)}` +
    `@${e.RAILWAY_TCP_PROXY_DOMAIN}:${e.RAILWAY_TCP_PROXY_PORT}/${e.POSTGRES_DB}`
  );
}

const args = process.argv.slice(2);
const argVal = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const tenantSlug = argVal("tenant");
const execute = args.includes("--execute");
const confirmSlug = argVal("confirm-tenant");
const liveOverride = args.includes("--live-tenant-override");

if (!tenantSlug) {
  console.error(
    "\nUsage: --tenant=<slug> [--execute --confirm-tenant=<slug> [--live-tenant-override]]\n",
  );
  process.exit(1);
}
if (execute) {
  if (confirmSlug !== tenantSlug) {
    console.error(
      `\n--execute requires --confirm-tenant=${tenantSlug} (type the slug back exactly). Nothing was written.\n`,
    );
    process.exit(1);
  }
  if (!isTestTenant(tenantSlug) && !liveOverride) {
    console.error(
      `\n"${tenantSlug}" is a LIVE tenant. Executing against it requires --live-tenant-override,\n` +
        `the tenant's explicit request, and a FRESH VALIDATED BACKUP taken first. Nothing was written.\n`,
    );
    process.exit(1);
  }
}

const pool = new Pool({ connectionString: resolveDbUrl() });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const N = (x) => Number(x ?? 0);
const r3 = (x) => Math.round(x * 1000) / 1000;
const r4 = (x) => Math.round(x * 10000) / 10000;

(async () => {
  const tenant = await prisma.tenant.findUnique({
    where: { slug: tenantSlug },
    select: { id: true, slug: true, status: true },
  });
  if (!tenant) {
    console.error(`Tenant "${tenantSlug}" not found. Nothing was written.`);
    process.exit(1);
  }

  console.log(`\n===== RECEIVING-UNITS REPAIR (${execute ? "EXECUTE" : "DRY-RUN"}) =====`);
  console.log(`Tenant: ${tenant.slug} (${tenant.status})  ·  HIGH signature only\n`);

  const products = await prisma.product.findMany({
    where: { tenantId: tenant.id, unitsPerBox: { gt: 1 }, currentStock: { lt: 0 } },
    select: { id: true, name: true, sku: true, unitsPerBox: true, currentStock: true },
    orderBy: { name: "asc" },
  });

  const plan = [];
  for (const p of products) {
    const upb = N(p.unitsPerBox);
    const movements = await prisma.stockMovement.findMany({
      where: { productId: p.id, type: "PURCHASE" },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        quantity: true,
        unitCost: true,
        createdAt: true,
        reference: true,
        notes: true,
      },
    });
    if (movements.length === 0) continue; // negative with no purchases = different cause

    const addedPieces = movements.reduce((s, m) => s + N(m.quantity) * (upb - 1), 0);
    const healed = r3(N(p.currentStock) + addedPieces);
    if (healed < 0) continue; // hypothesis does not fully heal → NOT the HIGH signature

    // Conservative lot matching: a lot must uniquely match ONE movement's
    // original qty+unitCost. Anything ambiguous is skipped and reported.
    const lots = await prisma.stockLot.findMany({
      where: { productId: p.id },
      select: { id: true, qty: true, remainingQty: true, unitCost: true },
    });
    const lotPlan = [];
    const lotSkips = [];
    const claimed = new Set();
    for (const m of movements) {
      const candidates = lots.filter(
        (l) =>
          !claimed.has(l.id) &&
          N(l.qty) === N(m.quantity) &&
          r4(N(l.unitCost)) === r4(N(m.unitCost)),
      );
      if (candidates.length === 1) {
        claimed.add(candidates[0].id);
        lotPlan.push({ lot: candidates[0], movement: m });
      } else {
        lotSkips.push({ movementId: m.id, candidates: candidates.length });
      }
    }

    plan.push({ p, upb, movements, addedPieces, healed, lotPlan, lotSkips });
  }

  if (plan.length === 0) {
    console.log("No products match the HIGH signature. Nothing to do.");
    process.exit(0);
  }

  for (const item of plan) {
    const { p, upb, movements, addedPieces, healed, lotPlan, lotSkips } = item;
    console.log(`• ${p.name} (${p.sku ?? "no sku"}) — box of ${upb}`);
    console.log(`    on-hand ${N(p.currentStock)} → ${healed}  (+${r3(addedPieces)} pieces)`);
    for (const m of movements) {
      console.log(
        `    movement ${m.id.slice(0, 8)}…  qty ${N(m.quantity)} → ${r3(N(m.quantity) * upb)}` +
          `  unitCost ${N(m.unitCost)} → ${r4(N(m.unitCost) / upb)}/pc`,
      );
    }
    console.log(`    lots: ${lotPlan.length} matched, ${lotSkips.length} ambiguous (skipped)`);
  }

  if (!execute) {
    console.log(
      `\nDRY-RUN complete — ${plan.length} product(s), nothing written.\n` +
        `To execute: add --execute --confirm-tenant=${tenantSlug}` +
        (isTestTenant(tenantSlug) ? "" : " --live-tenant-override (LIVE tenant — backup first!)") +
        "\n",
    );
    process.exit(0);
  }

  console.log(`\nEXECUTING against ${tenant.slug}…`);
  const repairedIds = [];
  for (const item of plan) {
    const { p, upb, movements, addedPieces, lotPlan } = item;
    await prisma.$transaction(async (tx) => {
      for (const m of movements) {
        await tx.stockMovement.update({
          where: { id: m.id },
          data: {
            quantity: r3(N(m.quantity) * upb),
            unitCost: r4(N(m.unitCost) / upb),
            notes:
              `${m.notes ? m.notes + " | " : ""}` +
              `receiving-units repair 2026-08-23: was qty=${N(m.quantity)} unitCost=${N(m.unitCost)} (box-entered)`,
          },
        });
      }
      for (const { lot, movement } of lotPlan) {
        await tx.stockLot.update({
          where: { id: lot.id },
          data: {
            qty: r3(N(lot.qty) * upb),
            remainingQty: r3(N(lot.remainingQty) * upb),
            unitCost: r4(N(movement.unitCost) / upb),
          },
        });
      }
      await tx.product.update({
        where: { id: p.id },
        data: { currentStock: { increment: r3(addedPieces) } },
      });
    });
    repairedIds.push(p.id);
    console.log(`  ✔ ${p.name}`);
  }

  console.log(
    `\n✅ Repaired ${repairedIds.length} product(s).\n\n` +
      `NEXT (required): re-derive average costs + movement snapshots with the shipped replay —\n` +
      `as an OPERATOR of this tenant call POST /inventory/recompute-costs with body:\n` +
      JSON.stringify({ productIds: repairedIds }, null, 2) +
      "\n",
  );
  process.exit(0);
})().catch((err) => {
  console.error("\nFAILED — transaction(s) rolled back per-product:", err.message);
  process.exit(1);
});
