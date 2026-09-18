/**
 * seed-marketing-screenshot-products.js
 *
 * Seeds the `test` tenant with a small, presentable "Health & Wellness"
 * convenience-store/gas-station category so the marketing site's real product
 * screenshots (PR #871 — wholesalers order builder, retailers invoice detail)
 * have believable, public-safe products to show. GENERIC descriptive names
 * only — never a real trademark (Tylenol/Advil/5-Hour Energy/etc. are a
 * trademark problem on a public page).
 *
 * Additive + idempotent, like seed-test-catalog.js:
 *   • assertTestTenant("test") — refuses to run against any non-test tenant.
 *   • On re-run, existing rows are refreshed for DEFINITIONAL fields only —
 *     currentStock/averageCost are left alone once a product exists.
 *
 * Also wires up a buyer-portal login on an EXISTING `test`-tenant customer
 * ("Hill Country Market") — a BuyerAccount + ACTIVE CustomerLink — plus one
 * SENT demo invoice against the new products, so the retailers marketing page
 * screenshot has a real, itemized, payable invoice to show in the buyer
 * portal (the operator dashboard has no buyer-facing "pay by card" surface).
 *
 * Usage (from repo root, against the local compose DB only):
 *   node apps/api/scripts/seed-marketing-screenshot-products.js
 *
 * Demo buyer login (apps/web /buyer/login): buyer-demo@test.local / BuyerDemo1!
 */

const { PrismaClient } = require("../../../node_modules/@prisma/client");
const { PrismaPg } = require("../../../node_modules/@prisma/adapter-pg");
const { Pool } = require("../../../node_modules/pg");
const bcrypt = require("../../../node_modules/bcrypt");
const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

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

const TENANT_SLUG = assertTestTenant("test", "seed-marketing-screenshot-products");

// Case price, retail units per case (unitsPerBox), starting stock in cases.
const PRODUCTS = [
  {
    name: "Acetaminophen 500mg Caplets · 24ct",
    sku: "HW-001",
    price: 32.99,
    cost: 19.8,
    box: 12,
    stock: 30,
  },
  {
    name: "Ibuprofen 200mg Tablets · 50ct",
    sku: "HW-002",
    price: 38.99,
    cost: 23.4,
    box: 12,
    stock: 26,
  },
  {
    name: "Antacid Chews · Berry · 16ct",
    sku: "HW-003",
    price: 21.99,
    cost: 13.2,
    box: 12,
    stock: 24,
  },
  {
    name: "Energy Shot · Berry · 12ct",
    sku: "HW-004",
    price: 18.99,
    cost: 11.4,
    box: 12,
    stock: 40,
  },
  {
    name: "Electrolyte Drink Mix · 10ct",
    sku: "HW-005",
    price: 16.99,
    cost: 10.2,
    box: 12,
    stock: 28,
  },
  {
    name: "Cough Drops · Honey Lemon · 30ct",
    sku: "HW-006",
    price: 14.99,
    cost: 9.0,
    box: 12,
    stock: 35,
  },
  {
    name: "Pain Relief Gel · 3oz",
    sku: "HW-007",
    price: 24.99,
    cost: 15.0,
    box: 12,
    stock: 18,
  },
  {
    name: "Allergy Relief Tablets · 30ct",
    sku: "HW-008",
    price: 29.99,
    cost: 18.0,
    box: 12,
    stock: 22,
  },
  {
    name: "Multivitamin Gummies · 60ct",
    sku: "HW-009",
    price: 34.99,
    cost: 21.0,
    box: 12,
    stock: 20,
  },
  {
    name: "Electrolyte Chews · Citrus · 12ct",
    sku: "HW-010",
    price: 17.99,
    cost: 10.8,
    box: 12,
    stock: 32,
  },
];

const CATEGORY = "Health & Wellness";
// Distinct barcode prefix ("9") so this never collides with seed-test-catalog.js
// ("2") or any other seed script's barcode range.
function barcodeFor(i) {
  return `9${String(100000000000 + i + 1).slice(1)}`;
}

const DEMO_BUYER_EMAIL = "buyer-demo@test.local";
const DEMO_BUYER_PASSWORD = "BuyerDemo1!";
const DEMO_CUSTOMER_BUSINESS_NAME = "Hill Country Market";
const DEMO_INVOICE_NUMBER = "INV-2026-0002";
// Four of the ten products above, used as the demo invoice's line items.
const DEMO_INVOICE_LINE_SKUS = ["HW-001", "HW-003", "HW-006", "HW-009"];

async function seedProducts(tenantId) {
  let created = 0;
  let refreshed = 0;
  const bySku = new Map();

  for (const [i, p] of PRODUCTS.entries()) {
    const definitional = {
      name: p.name,
      description: `${CATEGORY} — case of ${p.box}`,
      category: CATEGORY,
      unit: "case",
      pricePerUnit: p.price,
      barcode: barcodeFor(i),
      costingMethod: "AVCO",
      unitsPerBox: p.box,
      isActive: true,
    };

    const existing = await prisma.product.findUnique({
      where: { tenantId_sku: { tenantId, sku: p.sku } },
      select: { id: true },
    });

    if (existing) {
      await prisma.product.update({
        where: { id: existing.id },
        data: definitional,
        select: { id: true },
      });
      refreshed += 1;
      bySku.set(p.sku, existing.id);
      continue;
    }

    const row = await prisma.product.create({
      data: {
        tenantId,
        sku: p.sku,
        ...definitional,
        currentStock: p.stock,
        averageCost: p.cost,
      },
      select: { id: true },
    });
    created += 1;
    bySku.set(p.sku, row.id);
  }

  console.log(`   products created:   ${created}`);
  console.log(`   products refreshed: ${refreshed}`);
  return bySku;
}

/** Returns the demo customerId, creating the buyer-portal login if it's missing. */
async function ensureBuyerAccess(tenantId) {
  const customer = await prisma.customer.findFirst({
    where: { businessName: DEMO_CUSTOMER_BUSINESS_NAME, tenantId },
    select: { id: true },
  });
  if (!customer) {
    throw new Error(
      `Expected an existing "${DEMO_CUSTOMER_BUSINESS_NAME}" customer in tenant "${TENANT_SLUG}" ` +
        `(seeded by apps/api/prisma/seed.ts) — run local:seed first.`,
    );
  }

  let buyerAccount = await prisma.buyerAccount.findUnique({ where: { email: DEMO_BUYER_EMAIL } });
  if (!buyerAccount) {
    const passwordHash = await bcrypt.hash(DEMO_BUYER_PASSWORD, 10);
    buyerAccount = await prisma.buyerAccount.create({
      data: {
        email: DEMO_BUYER_EMAIL,
        passwordHash,
        passwordSet: true,
        name: "Sandra Fuentes",
        status: "ACTIVE",
        emailVerified: true,
      },
    });
    console.log(`   ✓ Created buyer account ${DEMO_BUYER_EMAIL} / ${DEMO_BUYER_PASSWORD}`);
  } else {
    console.log(`   ✓ Using existing buyer account ${DEMO_BUYER_EMAIL}`);
  }

  const existingLink = await prisma.customerLink.findUnique({
    where: { customerId: customer.id },
    select: { id: true, buyerAccountId: true, status: true },
  });
  if (!existingLink) {
    await prisma.customerLink.create({
      data: {
        buyerAccountId: buyerAccount.id,
        customerId: customer.id,
        tenantId,
        status: "ACTIVE",
        linkedAt: new Date(),
      },
    });
    console.log(`   ✓ Linked buyer account to "${DEMO_CUSTOMER_BUSINESS_NAME}"`);
  } else if (existingLink.buyerAccountId !== buyerAccount.id || existingLink.status !== "ACTIVE") {
    await prisma.customerLink.update({
      where: { customerId: customer.id },
      data: { buyerAccountId: buyerAccount.id, status: "ACTIVE", linkedAt: new Date() },
    });
    console.log(`   ✓ Re-linked buyer account to "${DEMO_CUSTOMER_BUSINESS_NAME}"`);
  } else {
    console.log(`   ✓ Buyer link already ACTIVE for "${DEMO_CUSTOMER_BUSINESS_NAME}"`);
  }

  return customer.id;
}

async function ensureDemoInvoice(tenantId, customerId, productIdBySku) {
  const existing = await prisma.invoice.findUnique({
    where: { tenantId_invoiceNumber: { tenantId, invoiceNumber: DEMO_INVOICE_NUMBER } },
    select: { id: true },
  });
  if (existing) {
    console.log(`   ✓ Demo invoice ${DEMO_INVOICE_NUMBER} already exists`);
    return;
  }

  const lines = DEMO_INVOICE_LINE_SKUS.map((sku) => {
    const p = PRODUCTS.find((x) => x.sku === sku);
    const qty = 2;
    const subtotal = Math.round(p.price * qty * 100) / 100;
    return {
      productId: productIdBySku.get(sku),
      description: p.name,
      qty,
      unitPrice: p.price,
      subtotal,
    };
  });
  const subtotal = Math.round(lines.reduce((sum, l) => sum + l.subtotal, 0) * 100) / 100;

  const issueDate = new Date();
  const dueDate = new Date(issueDate.getTime() + 30 * 24 * 60 * 60 * 1000);

  await prisma.invoice.create({
    data: {
      tenantId,
      customerId,
      invoiceNumber: DEMO_INVOICE_NUMBER,
      status: "SENT",
      subtotal,
      taxAmount: 0,
      total: subtotal,
      issueDate,
      dueDate,
      sentAt: issueDate,
      paymentTermsLabel: "Net 30",
      items: { create: lines },
    },
  });
  console.log(
    `   ✓ Created demo invoice ${DEMO_INVOICE_NUMBER} (${lines.length} items, $${subtotal})`,
  );
}

async function main() {
  const isRailway = dbUrl.includes("railway") || dbUrl.includes("rlwy");
  if (isRailway) {
    throw new Error(
      "seed-marketing-screenshot-products.js refuses to run against a Railway-shaped " +
        "DATABASE_URL — this seed is for the local compose DB only.",
    );
  }
  console.log(`\n🧴 Marketing-screenshot product seed — local dev`);
  console.log(`   DB: ${dbUrl.replace(/:\/\/[^@]+@/, "://***@")}`);
  console.log(`   Tenant: ${TENANT_SLUG}\n`);

  const tenant = await prisma.tenant.findUnique({ where: { slug: TENANT_SLUG } });
  if (!tenant) {
    throw new Error(`Tenant "${TENANT_SLUG}" does not exist — run local:seed first.`);
  }
  const tenantId = tenant.id;

  const productIdBySku = await seedProducts(tenantId);
  const customerId = await ensureBuyerAccess(tenantId);
  await ensureDemoInvoice(tenantId, customerId, productIdBySku);

  console.log(`\n✅ Marketing-screenshot product seed complete.\n`);
}

main()
  .catch((e) => {
    console.error("\n❌ Marketing-screenshot product seed failed:", e.message ?? e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
