/**
 * nuke-tenant-data.js
 *
 * Wipes ALL tenant-scoped data and buyer accounts, leaving the database
 * ready for real production use.
 *
 * PRESERVES: SUPER_ADMIN users (tenantId IS NULL) — the platform admin account.
 * DELETES:   All Tenants and everything that belongs to them (Users, Customers,
 *            Drivers, Products, Suppliers, Orders, Invoices, Routes, etc.)
 *            All BuyerAccount and CustomerLink records.
 *
 * LOCAL DEV ONLY — blocked against Railway/production by productionGuard.
 *
 * Usage (from repo root):
 *   node apps/api/scripts/nuke-tenant-data.js --confirm
 */

const { PrismaClient } = require("../../../node_modules/@prisma/client");
const { PrismaPg } = require("../../../node_modules/@prisma/adapter-pg");
const { Pool } = require("../../../node_modules/pg");
const { productionGuard } = require("./lib/production-guard");

productionGuard({ requireFlag: "--confirm" });

const dbUrl = process.env.DATABASE_URL ?? "postgresql://user:pass@localhost:5432/routeflow_dev";

const pool = new Pool({ connectionString: dbUrl });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const isRailway = dbUrl.includes("railway") || dbUrl.includes("rlwy");

async function main() {
  console.log("\n========================================================");
  console.log("  RouteFlow — Nuke Tenant Data");
  console.log(`  Target: ${isRailway ? "⚠  RAILWAY PRODUCTION" : "Local dev"}`);
  console.log(`  DB: ${dbUrl.replace(/:\/\/[^@]+@/, "://***@")}`);
  console.log("========================================================\n");

  // ── Pre-flight counts ────────────────────────────────────────────────────
  const [tenants, buyers, users, customers, products, orders, invoices] = await Promise.all([
    prisma.tenant.count(),
    prisma.buyerAccount.count(),
    prisma.user.count({ where: { tenantId: { not: null } } }),
    prisma.customer.count(),
    prisma.product.count(),
    prisma.order.count(),
    prisma.invoice.count(),
  ]);

  const superAdmins = await prisma.user.count({ where: { tenantId: null } });

  console.log("Records to be DELETED:");
  console.log(`  Tenants:         ${tenants}`);
  console.log(`  BuyerAccounts:   ${buyers}`);
  console.log(`  Tenant Users:    ${users}`);
  console.log(`  Customers:       ${customers}`);
  console.log(`  Products:        ${products}`);
  console.log(`  Orders:          ${orders}`);
  console.log(`  Invoices:        ${invoices}`);
  console.log(`\nRecords PRESERVED:`);
  console.log(`  SUPER_ADMIN users: ${superAdmins}`);

  if (tenants === 0 && buyers === 0 && customers === 0 && products === 0) {
    console.log("\n✅ Database is already clean. Nothing to delete.");
    return;
  }

  console.log("\n--- Deleting (this may take a moment) ---\n");

  // ── Step 1: Buyer portal ─────────────────────────────────────────────────
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "BuyerRefreshToken", "CustomerLink", "BuyerAccount" CASCADE`,
  );
  console.log("✓ Buyer portal data cleared");

  // ── Step 2: Wipe all tenant-scoped tables in one TRUNCATE CASCADE ────────
  //    This handles all FK dependencies automatically.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AuditLog",
      "Message",
      "ReturnItem", "Return",
      "InvoicePayment", "InvoiceItem",
      "BillPayment", "VendorBillItem", "VendorBill",
      "PurchaseOrderItem", "PurchaseOrder",
      "EstimateItem", "Estimate",
      "ExpenseLineItem", "Expense", "ExpenseCategory", "MileageRate",
      "StockMovement", "StockLot",
      "CreditNote", "AdvancePayment",
      "Payment", "PaymentCounter",
      "TransactionItem", "Transaction",
      "Invoice", "RecurringInvoiceItem", "RecurringInvoice",
      "OrderTemplateItem", "OrderTemplate",
      "OrderItem", "Order",
      "DeliveryMutation",
      "RouteRunStop", "RouteRun",
      "RouteCustomer", "RouteStop", "Route",
      "CustomerTagAssignment", "CustomerTag",
      "CustomerComment", "ContactPerson",
      "CustomerPrice", "ProductMapping",
      "CustomerAddress",
      "Customer", "Driver",
      "Product", "Supplier",
      "DeviceToken", "RefreshToken", "UserPreference"
    CASCADE
  `);
  console.log("✓ All tenant-scoped operational data cleared");

  // ── Step 3: Delete tenant users (not SUPER_ADMIN) ────────────────────────
  const deletedUsers = await prisma.user.deleteMany({
    where: { tenantId: { not: null } },
  });
  console.log(`✓ Tenant users deleted: ${deletedUsers.count}`);

  // ── Step 4: Delete tenant configurations ─────────────────────────────────
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "TenantConfig", "TenantGoogleOAuth", "TenantSubscription", "TenantAddon"
    CASCADE
  `);
  console.log("✓ Tenant configurations cleared");

  // ── Step 5: Delete tenants ────────────────────────────────────────────────
  const deletedTenants = await prisma.tenant.deleteMany({});
  console.log(`✓ Tenants deleted: ${deletedTenants.count}`);

  // ── Step 6: Clean up SystemConfig (tenant-scoped rows only) ──────────────
  try {
    const r = await prisma.systemConfig.deleteMany({
      where: { tenantId: { not: null } },
    });
    if (r.count > 0) console.log(`✓ SystemConfig (tenant-scoped): ${r.count} deleted`);
  } catch {
    // SystemConfig may not have tenantId field — ignore
  }

  // ── Done ─────────────────────────────────────────────────────────────────
  console.log("\n========================================================");
  console.log("  ✅ Done! Database is clean.");
  console.log("========================================================\n");

  const remaining = await prisma.user.count({ where: { tenantId: null } });
  const remainingTenants = await prisma.tenant.count();
  console.log(`Preserved SUPER_ADMIN accounts: ${remaining}`);
  console.log(`Remaining tenants: ${remainingTenants}`);
  console.log(`Remaining buyers: ${await prisma.buyerAccount.count()}`);
}

main()
  .catch((e) => {
    console.error("\n❌ Error:", e.message ?? e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
