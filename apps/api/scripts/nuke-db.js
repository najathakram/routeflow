// PRODUCTION GUARD — must be first executable code
const { productionGuard } = require("./lib/production-guard");
productionGuard({ requireFlag: "--i-know-this-deletes-everything" });

/**
 * Wipe all business data from the database (preserves operator/admin users).
 *
 * Usage — local dev ONLY:
 *   node apps/api/scripts/nuke-db.js --i-know-this-deletes-everything
 *
 * Pass --all to also delete operator users (full wipe):
 *   node apps/api/scripts/nuke-db.js --i-know-this-deletes-everything --all
 *
 * NEVER run via: railway run node apps/api/scripts/nuke-db.js
 * The production guard will block it, but don't even try.
 */

const { PrismaClient } = require("../../../node_modules/@prisma/client");
const { PrismaPg } = require("../../../node_modules/@prisma/adapter-pg");
const { Pool } = require("../../../node_modules/pg");

// Prefer the public URL when running locally (internal .railway.internal hostnames
// are only reachable from within Railway's network).
const dbUrl =
  process.env.DATABASE_PUBLIC_URL ||
  process.env.DATABASE_URL ||
  "postgresql://user:pass@localhost:5432/routeflow_dev";
const deleteAllUsers = process.argv.includes("--all");

const pool = new Pool({ connectionString: dbUrl });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("🗑  RouteFlow Database Nuke");
  console.log(`   Database: ${dbUrl.replace(/:([^:@]+)@/, ":***@")}`);
  console.log(
    `   Mode    : ${deleteAllUsers ? "FULL (including users)" : "Business data only (preserving operators)"}`,
  );
  console.log("");

  // Safety prompt — just print a warning and proceed
  console.log("⚠️  This will permanently delete all data. Starting in 3 seconds…");
  await new Promise((r) => setTimeout(r, 3000));

  console.log("🔥 Truncating all business data tables…");

  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "Message",
      "ReturnItem", "Return",
      "InvoicePayment", "InvoiceItem",
      "BillPayment", "VendorBill",
      "PurchaseOrderItem", "PurchaseOrder",
      "EstimateItem", "Estimate",
      "Expense", "ExpenseCategory",
      "StockMovement",
      "CreditNote",
      "Payment",
      "Invoice",
      "OrderTemplateItem", "OrderTemplate",
      "OrderItem", "Order",
      "Transaction", "TransactionItem", "DeliveryMutation",
      "RouteRunStop", "RouteRun", "RouteCustomer", "RouteStop", "Route",
      "DeviceToken", "RefreshToken",
      "CustomerAddress", "Customer",
      "Driver",
      "Product", "Supplier",
      "AdvancePayment", "RecurringInvoice"
    CASCADE
  `);
  console.log("✅ Business data tables cleared.");

  if (deleteAllUsers) {
    console.log("🔥 Deleting ALL users (--all flag set)…");
    await prisma.user.deleteMany({});
    console.log("✅ All users deleted.");
  } else {
    // Delete non-operator users (customers/drivers that lost their FK references)
    const deleted = await prisma.user.deleteMany({
      where: { role: { not: "OPERATOR" } },
    });
    console.log(`✅ Cleaned up ${deleted.count} non-operator user accounts.`);

    const remaining = await prisma.user.count();
    console.log(`ℹ️  ${remaining} operator user(s) preserved.`);
  }

  console.log("\n✨ Database nuked successfully!");
}

main()
  .catch((e) => {
    console.error("❌ Nuke failed:", e.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
