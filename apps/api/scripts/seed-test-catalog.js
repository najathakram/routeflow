/**
 * seed-test-catalog.js
 *
 * Seeds the `test` tenant with a realistic DUMMY catalog (generic product names,
 * no real brands or client identifiers) so the inventory flows — stock count,
 * set/override cost basis, bulk cost, recompute, adjustments — can be exercised
 * end to end.
 *
 * Deliberately varied so every flow has something to test:
 *   • healthy / low / out-of-stock levels (counts + restock + reorder alerts)
 *   • products WITH and WITHOUT a cost basis (the "Set cost" / "Bulk set" flows)
 *   • FIFO / AVCO / STANDARD / LAST_COST costing methods
 *   • boxed (unitsPerBox) vs loose units
 *   • opening PURCHASE movements + stock lots (cost-history + recompute have data)
 *
 * SAFE + IDEMPOTENT:
 *   • assertTestTenant("test") — refuses to run against any non-test tenant.
 *   • On re-run, existing products are refreshed for DEFINITIONAL fields only
 *     (name/price/category/costing/reorder/unitsPerBox) — currentStock,
 *     averageCost and movements/lots are LEFT ALONE so it never clobbers changes
 *     you made while testing.
 *
 * Usage (from repo root):
 *   Local:   node apps/api/scripts/seed-test-catalog.js
 *   Prod:    railway run --service postgres node apps/api/scripts/seed-test-catalog.js
 */

const { PrismaClient } = require("../../../node_modules/@prisma/client");
const { PrismaPg } = require("../../../node_modules/@prisma/adapter-pg");
const { Pool } = require("../../../node_modules/pg");
const bcrypt = require("../../../node_modules/bcrypt");
const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

// When invoked via `railway run --service postgres`, the injected DATABASE_URL
// points at the INTERNAL host (unreachable from a local machine). Build the
// public TCP-proxy URL from the injected vars instead — mirrors prod-migrate.mjs.
// Falls back to a plain DATABASE_URL for local dev.
function resolveDbUrl() {
  const e = process.env;
  if (
    e.RAILWAY_TCP_PROXY_DOMAIN &&
    e.RAILWAY_TCP_PROXY_PORT &&
    e.POSTGRES_USER &&
    e.POSTGRES_PASSWORD &&
    e.POSTGRES_DB
  ) {
    return (
      `postgresql://${e.POSTGRES_USER}:${encodeURIComponent(e.POSTGRES_PASSWORD)}` +
      `@${e.RAILWAY_TCP_PROXY_DOMAIN}:${e.RAILWAY_TCP_PROXY_PORT}/${e.POSTGRES_DB}`
    );
  }
  return e.DATABASE_URL ?? "postgresql://user:pass@localhost:5432/routeflow_dev";
}

const dbUrl = resolveDbUrl();
const pool = new Pool({ connectionString: dbUrl });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const TENANT_SLUG = assertTestTenant("test", "seed-test-catalog");
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

// ─── Catalog data (all generic / fictional) ──────────────────────────────────
// Per item: { name, unit, price, cost, stock, box, reorder, costing?, tier2? }
//   cost: null  → no cost basis yet (shows under "missing cost" → Set cost flow)
//   box:  null  → loose unit (no unitsPerBox)
//   costing: overrides the group default; STANDARD stores standardCost
const GROUPS = [
  {
    category: "Beverages",
    prefix: "BEV",
    costing: "AVCO",
    items: [
      {
        name: "Cola Soda 12oz Can",
        unit: "case",
        price: 8.5,
        cost: 5.2,
        stock: 40,
        box: 24,
        reorder: 15,
        tier2: 8.1,
      },
      {
        name: "Diet Cola 12oz Can",
        unit: "case",
        price: 8.5,
        cost: 5.2,
        stock: 22,
        box: 24,
        reorder: 15,
      },
      {
        name: "Lemon-Lime Soda 12oz Can",
        unit: "case",
        price: 8.25,
        cost: 5.0,
        stock: 8,
        box: 24,
        reorder: 12,
      },
      {
        name: "Spring Water 500ml",
        unit: "case",
        price: 4.75,
        cost: 2.8,
        stock: 60,
        box: 24,
        reorder: 20,
      },
      {
        name: "Sparkling Water 12oz",
        unit: "case",
        price: 9.0,
        cost: 6.1,
        stock: 0,
        box: 12,
        reorder: 10,
      },
      {
        name: "Orange Juice 1gal",
        unit: "case",
        price: 18.0,
        cost: 12.5,
        stock: 15,
        box: 6,
        reorder: 6,
        costing: "FIFO",
      },
      {
        name: "Apple Juice 64oz",
        unit: "case",
        price: 14.0,
        cost: 9.2,
        stock: 18,
        box: 8,
        reorder: 8,
        costing: "FIFO",
      },
      {
        name: "Energy Drink 16oz",
        unit: "case",
        price: 22.0,
        cost: 15.4,
        stock: 30,
        box: 12,
        reorder: 10,
        tier2: 21.0,
      },
      {
        name: "Iced Tea 20oz",
        unit: "case",
        price: 12.0,
        cost: 7.8,
        stock: 12,
        box: 12,
        reorder: 12,
      },
      {
        name: "Cold Brew Coffee 11oz",
        unit: "case",
        price: 26.0,
        cost: null,
        stock: 24,
        box: 12,
        reorder: 12,
      },
    ],
  },
  {
    category: "Snacks",
    prefix: "SNK",
    costing: "AVCO",
    items: [
      {
        name: "Potato Chips Salted 1.5oz",
        unit: "box",
        price: 15.0,
        cost: 9.5,
        stock: 35,
        box: 40,
        reorder: 15,
      },
      {
        name: "Tortilla Chips 2oz",
        unit: "box",
        price: 16.0,
        cost: 10.2,
        stock: 10,
        box: 40,
        reorder: 12,
      },
      {
        name: "Pretzels 2oz",
        unit: "box",
        price: 14.0,
        cost: 8.8,
        stock: 20,
        box: 40,
        reorder: 12,
      },
      {
        name: "Chocolate Bar 1.5oz",
        unit: "box",
        price: 24.0,
        cost: 15.6,
        stock: 28,
        box: 36,
        reorder: 18,
        tier2: 22.8,
      },
      {
        name: "Gummy Candy 5oz",
        unit: "box",
        price: 18.0,
        cost: 11.4,
        stock: 6,
        box: 24,
        reorder: 10,
      },
      {
        name: "Sandwich Cookies 2oz",
        unit: "box",
        price: 13.5,
        cost: 8.1,
        stock: 44,
        box: 30,
        reorder: 15,
      },
      {
        name: "Mixed Nuts 2oz",
        unit: "box",
        price: 28.0,
        cost: 19.0,
        stock: 0,
        box: 24,
        reorder: 8,
      },
      {
        name: "Microwave Popcorn 3pk",
        unit: "case",
        price: 20.0,
        cost: 12.8,
        stock: 16,
        box: 12,
        reorder: 10,
      },
      {
        name: "Beef Jerky 3oz",
        unit: "box",
        price: 42.0,
        cost: 30.0,
        stock: 9,
        box: 12,
        reorder: 6,
        costing: "LAST_COST",
      },
      {
        name: "Granola Bar 1.4oz",
        unit: "box",
        price: 17.0,
        cost: null,
        stock: 25,
        box: 48,
        reorder: 20,
      },
    ],
  },
  {
    category: "Cleaning Supplies",
    prefix: "CLN",
    costing: "AVCO",
    items: [
      {
        name: "Dish Soap 24oz",
        unit: "each",
        price: 3.2,
        cost: 1.9,
        stock: 30,
        box: null,
        reorder: 12,
      },
      {
        name: "Liquid Bleach 1gal",
        unit: "each",
        price: 4.5,
        cost: 2.6,
        stock: 14,
        box: null,
        reorder: 8,
      },
      {
        name: "Paper Towels 2-ply",
        unit: "case",
        price: 22.0,
        cost: 14.5,
        stock: 20,
        box: 12,
        reorder: 8,
      },
      {
        name: "Trash Bags 13gal 40ct",
        unit: "each",
        price: 6.8,
        cost: 4.1,
        stock: 18,
        box: null,
        reorder: 10,
      },
      { name: "Sponges 6pk", unit: "each", price: 4.0, cost: 2.2, stock: 5, box: null, reorder: 8 },
      {
        name: "All-Purpose Cleaner 32oz",
        unit: "each",
        price: 3.9,
        cost: 2.3,
        stock: 26,
        box: null,
        reorder: 12,
        costing: "STANDARD",
      },
    ],
  },
  {
    category: "Paper Goods",
    prefix: "PPR",
    costing: "AVCO",
    items: [
      {
        name: "Napkins 250ct",
        unit: "pack",
        price: 5.5,
        cost: 3.1,
        stock: 40,
        box: null,
        reorder: 15,
      },
      {
        name: "Foam Cups 12oz 50ct",
        unit: "pack",
        price: 4.2,
        cost: 2.4,
        stock: 22,
        box: null,
        reorder: 12,
      },
      {
        name: "Paper Plates 9in 100ct",
        unit: "pack",
        price: 7.0,
        cost: 4.3,
        stock: 12,
        box: null,
        reorder: 10,
      },
      {
        name: "Toilet Paper 12-roll",
        unit: "case",
        price: 16.0,
        cost: 10.0,
        stock: 8,
        box: null,
        reorder: 8,
      },
      {
        name: "Aluminum Foil 200ft",
        unit: "each",
        price: 8.5,
        cost: 5.2,
        stock: 15,
        box: null,
        reorder: 8,
      },
    ],
  },
  {
    category: "Dairy & Refrigerated",
    prefix: "DRY",
    costing: "FIFO",
    items: [
      {
        name: "Whole Milk 1gal",
        unit: "each",
        price: 4.2,
        cost: 2.9,
        stock: 24,
        box: null,
        reorder: 12,
      },
      {
        name: "Shredded Cheese 2lb",
        unit: "each",
        price: 9.5,
        cost: 6.4,
        stock: 10,
        box: null,
        reorder: 8,
      },
      {
        name: "Butter 1lb 4-stick",
        unit: "each",
        price: 5.0,
        cost: 3.2,
        stock: 18,
        box: null,
        reorder: 10,
      },
      {
        name: "Greek Yogurt 32oz",
        unit: "each",
        price: 5.8,
        cost: 3.6,
        stock: 0,
        box: null,
        reorder: 8,
      },
      {
        name: "Large Eggs 18ct",
        unit: "each",
        price: 4.6,
        cost: 2.8,
        stock: 30,
        box: null,
        reorder: 15,
      },
    ],
  },
  {
    category: "Condiments & Pantry",
    prefix: "PAN",
    costing: "AVCO",
    items: [
      {
        name: "Ketchup 38oz",
        unit: "each",
        price: 3.8,
        cost: 2.1,
        stock: 28,
        box: null,
        reorder: 12,
      },
      {
        name: "Yellow Mustard 20oz",
        unit: "each",
        price: 2.9,
        cost: 1.5,
        stock: 22,
        box: null,
        reorder: 10,
      },
      {
        name: "Mayonnaise 30oz",
        unit: "each",
        price: 5.4,
        cost: 3.3,
        stock: 6,
        box: null,
        reorder: 8,
      },
      {
        name: "Granulated Sugar 4lb",
        unit: "each",
        price: 4.1,
        cost: 2.4,
        stock: 20,
        box: null,
        reorder: 10,
      },
      {
        name: "All-Purpose Flour 5lb",
        unit: "each",
        price: 3.6,
        cost: 2.0,
        stock: 16,
        box: null,
        reorder: 10,
      },
      {
        name: "White Rice 5lb",
        unit: "each",
        price: 6.5,
        cost: 4.0,
        stock: 14,
        box: null,
        reorder: 8,
      },
      {
        name: "Vegetable Oil 48oz",
        unit: "each",
        price: 5.9,
        cost: 3.7,
        stock: 0,
        box: null,
        reorder: 8,
      },
      {
        name: "Table Salt 26oz",
        unit: "each",
        price: 1.8,
        cost: 0.9,
        stock: 40,
        box: null,
        reorder: 15,
      },
    ],
  },
  {
    category: "Frozen",
    prefix: "FRZ",
    costing: "FIFO",
    items: [
      {
        name: "Frozen Fries 2lb",
        unit: "each",
        price: 4.8,
        cost: 3.0,
        stock: 20,
        box: null,
        reorder: 10,
      },
      {
        name: "Frozen Pizza 12in",
        unit: "each",
        price: 6.2,
        cost: 4.1,
        stock: 12,
        box: null,
        reorder: 10,
      },
      {
        name: "Vanilla Ice Cream 1.5qt",
        unit: "each",
        price: 5.5,
        cost: 3.4,
        stock: 8,
        box: null,
        reorder: 8,
      },
      {
        name: "Frozen Mixed Veg 2lb",
        unit: "each",
        price: 3.9,
        cost: 2.3,
        stock: 18,
        box: null,
        reorder: 10,
      },
    ],
  },
  {
    category: "Household",
    prefix: "HHD",
    costing: "AVCO",
    items: [
      {
        name: "AA Batteries 8pk",
        unit: "each",
        price: 7.5,
        cost: 4.6,
        stock: 24,
        box: null,
        reorder: 12,
      },
      {
        name: "LED Bulb 60W 4pk",
        unit: "each",
        price: 9.0,
        cost: 5.8,
        stock: 10,
        box: null,
        reorder: 8,
      },
      {
        name: "Wooden Matches 3-box",
        unit: "each",
        price: 2.2,
        cost: 1.1,
        stock: 30,
        box: null,
        reorder: 10,
      },
      {
        name: "Tea Light Candles 50ct",
        unit: "each",
        price: 6.0,
        cost: null,
        stock: 15,
        box: null,
        reorder: 8,
      },
    ],
  },
];

// Flatten into product rows with generated SKU + barcode.
function buildProducts() {
  const rows = [];
  let barcodeSeq = 1;
  for (const group of GROUPS) {
    group.items.forEach((it, i) => {
      const costing = it.costing ?? group.costing;
      rows.push({
        name: it.name,
        sku: `${group.prefix}-${String(i + 1).padStart(3, "0")}`,
        barcode: `2${String(100000000000 + barcodeSeq).slice(1)}`, // 12-digit, unique
        category: group.category,
        unit: it.unit,
        pricePerUnit: it.price,
        priceTier2: it.tier2 ?? 0,
        cost: it.cost, // null = no cost basis
        stock: it.stock,
        unitsPerBox: it.box,
        reorderPoint: it.reorder,
        reorderQty: it.reorder != null ? it.reorder * 2 : null,
        costingMethod: costing,
      });
      barcodeSeq += 1;
    });
  }
  return rows;
}

async function resolveOperatorId(tenantId) {
  const op = await prisma.user.findFirst({
    where: { tenantId, role: { in: ["OPERATOR", "TENANT_ADMIN"] } },
    orderBy: { createdAt: "asc" },
  });
  if (op) return op.id;
  if (DRY_RUN) return null; // would create a test operator on a real run
  // Fresh local tenant with no operator — create one so movements have an author
  // and there's a password login for testing.
  const hash = await bcrypt.hash("Test@1234", 10);
  const created = await prisma.user.create({
    data: {
      email: "test_operator@test.local",
      username: "test_operator",
      password: hash,
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
    },
  });
  console.log("  ✓ Created operator test_operator / Test@1234 (none existed)");
  return created.id;
}

async function main() {
  const isRailway = dbUrl.includes("railway") || dbUrl.includes("rlwy");
  console.log(
    `\n🌱 Test-catalog seed — ${isRailway ? "⚠  RAILWAY (prod)" : "Local dev"}${DRY_RUN ? " [DRY RUN — no writes]" : ""}`,
  );
  console.log(`   DB: ${dbUrl.replace(/:\/\/[^@]+@/, "://***@")}`);
  console.log(`   Tenant: ${TENANT_SLUG}\n`);

  // ── Find or create the test tenant ────────────────────────────────────────
  let tenant = await prisma.tenant.findUnique({ where: { slug: TENANT_SLUG } });
  if (!tenant) {
    if (DRY_RUN) {
      console.log(`  · tenant "${TENANT_SLUG}" does not exist — a real run would create it.`);
      console.log("\n(dry run) nothing written.\n");
      return;
    }
    tenant = await prisma.tenant.create({
      data: { slug: TENANT_SLUG, name: "Test RouteFlow", status: "ACTIVE", plan: "PROFESSIONAL" },
    });
    await prisma.tenantConfig
      .create({ data: { tenantId: tenant.id, businessName: "Test RouteFlow" } })
      .catch(() => {});
    console.log(`  ✓ Created tenant "${TENANT_SLUG}" (id: ${tenant.id})`);
  } else {
    console.log(`  ✓ Using existing tenant "${TENANT_SLUG}" (id: ${tenant.id})`);
  }
  const tenantId = tenant.id;
  const operatorId = await resolveOperatorId(tenantId);

  const openingDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // ~30 days ago
  const products = buildProducts();

  let created = 0;
  let refreshed = 0;
  let openingLots = 0;
  const conflicts = [];

  for (const p of products) {
    const isStandard = p.costingMethod === "STANDARD";
    const hasCost = p.cost != null;

    // Definitional fields refreshed on every run (never touches live stock/cost).
    const definitional = {
      name: p.name,
      description: `${p.category} — ${p.unit}`,
      category: p.category,
      unit: p.unit,
      pricePerUnit: p.pricePerUnit,
      priceTier2: p.priceTier2,
      barcode: p.barcode,
      costingMethod: p.costingMethod,
      standardCost: isStandard && hasCost ? p.cost : null,
      reorderPoint: p.reorderPoint,
      reorderQty: p.reorderQty,
      unitsPerBox: p.unitsPerBox,
      isActive: true,
    };

    try {
      // select id only — prod may lag the local Prisma client by a column
      // (e.g. an unapplied migration); reading the full row would 500.
      const existing = await prisma.product.findUnique({
        where: { tenantId_sku: { tenantId, sku: p.sku } },
        select: { id: true },
      });

      if (existing) {
        if (!DRY_RUN)
          await prisma.product.update({
            where: { id: existing.id },
            data: definitional,
            select: { id: true },
          });
        refreshed += 1;
        continue;
      }

      created += 1;
      const wantsOpening = hasCost && !isStandard && p.stock > 0;
      if (wantsOpening) openingLots += 1;
      if (DRY_RUN) continue;

      // New product — set opening stock + cost too.
      const prod = await prisma.product.create({
        data: {
          tenantId,
          sku: p.sku,
          ...definitional,
          currentStock: p.stock,
          // STANDARD costing values via standardCost; others via averageCost.
          averageCost: hasCost && !isStandard ? p.cost : null,
        },
        select: { id: true },
      });

      // Opening PURCHASE movement + lot for stocked, costed, lot-based products
      // so cost-history + FIFO/LIFO + recompute have real data to work with.
      if (wantsOpening) {
        await prisma.stockMovement.create({
          data: {
            tenantId,
            productId: prod.id,
            type: "PURCHASE",
            quantity: p.stock,
            unitCost: p.cost,
            avgCostAfter: p.cost,
            stockAfter: p.stock,
            reference: "SEED-OPENING",
            notes: "Opening stock (seed)",
            performedById: operatorId,
            createdAt: openingDate,
          },
        });
        await prisma.stockLot.create({
          data: {
            tenantId,
            productId: prod.id,
            purchaseDate: openingDate,
            qty: p.stock,
            remainingQty: p.stock,
            unitCost: p.cost,
            reference: "SEED-OPENING",
            notes: "Opening stock (seed)",
          },
        });
      }
    } catch (e) {
      conflicts.push({ sku: p.sku, name: p.name, reason: e.message ?? String(e) });
    }
  }

  const noCost = products.filter((p) => p.cost == null).length;
  const outOfStock = products.filter((p) => p.stock === 0).length;
  const lowStock = products.filter(
    (p) => p.stock > 0 && p.reorderPoint != null && p.stock <= p.reorderPoint,
  ).length;
  const existingCount = await prisma.product.count({ where: { tenantId } });

  console.log(`\n📦 Catalog seed summary${DRY_RUN ? " [DRY RUN]" : ""}`);
  console.log(`   products already in tenant: ${existingCount}`);
  console.log(`   products defined by seed:   ${products.length}`);
  console.log(`   ${DRY_RUN ? "would create" : "created"}:            ${created}`);
  console.log(`   ${DRY_RUN ? "would refresh" : "refreshed"} (keeps stock/cost): ${refreshed}`);
  console.log(`   ${DRY_RUN ? "would add" : "added"} opening lots: ${openingLots}`);
  console.log(
    `   test data mix → missing-cost: ${noCost} · out-of-stock: ${outOfStock} · low-stock: ${lowStock}`,
  );
  if (conflicts.length) {
    console.log(`\n⚠  ${conflicts.length} product(s) skipped (name/barcode already in use):`);
    for (const c of conflicts) console.log(`     - ${c.sku} ${c.name}: ${c.reason}`);
  }
  console.log(`\n✅ Test-catalog seed ${DRY_RUN ? "dry run" : ""} complete.\n`);
}

main()
  .catch((e) => {
    console.error("\n❌ Test-catalog seed failed:", e.message ?? e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
