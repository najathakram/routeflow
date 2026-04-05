/**
 * Cleanup script — removes all QA/dummy data added by fresh-data.js.
 * Preserves OPERATOR user accounts (e.g. admin).
 *
 * Run from repo root: node apps/api/scripts/cleanup-qa-data.js
 */

const { PrismaClient } = require("../../../node_modules/@prisma/client");
const { PrismaPg } = require("../../../node_modules/@prisma/adapter-pg");
const { Pool } = require("../../../node_modules/pg");
const path = require("path");
const fs = require("fs");

function loadEnvDatabaseUrl() {
  const envPath = path.join(__dirname, "../.env");
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf8");
    const match = content.match(/^DATABASE_URL\s*=\s*["']?([^"'\r\n]+)["']?/m);
    if (match) return match[1];
  }
  return process.env.DATABASE_URL || "postgresql://user:pass@localhost:5432/routeflow_dev";
}

const dbUrl = loadEnvDatabaseUrl();
console.log(`\n🔗 Connecting to: ${dbUrl.replace(/:([^:@]+)@/, ':***@')}`);

const pool = new Pool({ connectionString: dbUrl });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("\n🗑  Removing all QA dummy data...\n");

  // Step 1: Truncate all operational/entity tables (same order as fresh-data.js)
  console.log("   Truncating operational tables...");
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "Message", "ReturnItem", "Return", "InvoicePayment", "InvoiceItem",
      "BillPayment", "VendorBill", "PurchaseOrderItem", "PurchaseOrder",
      "EstimateItem", "Estimate", "Expense", "ExpenseCategory",
      "StockMovement", "CreditNote", "Payment", "Invoice",
      "OrderTemplateItem", "OrderTemplate", "OrderItem", "Order",
      "Transaction", "TransactionItem", "DeliveryMutation",
      "RouteRunStop", "RouteRun", "RouteCustomer", "RouteStop", "Route",
      "DeviceToken", "RefreshToken",
      "CustomerAddress", "Customer", "Driver",
      "Product", "Supplier"
    CASCADE
  `);
  console.log("   ✓ Operational tables cleared.");

  // Step 2: Remove all non-OPERATOR user accounts (customers + drivers created by seed)
  const deleted = await prisma.user.deleteMany({
    where: { role: { not: "OPERATOR" } },
  });
  console.log(`   ✓ Removed ${deleted.count} non-operator user accounts (customers + drivers).`);

  // Step 3: Count remaining users (should be only OPERATOR accounts)
  const remaining = await prisma.user.findMany({ select: { username: true, role: true } });
  console.log(`\n✅ Cleanup complete. Remaining users (operators only):`);
  remaining.forEach(u => console.log(`   - ${u.username} (${u.role})`));

  await prisma.$disconnect();
  await pool.end();
}

main().catch((err) => {
  console.error("\n❌ Cleanup failed:", err.message);
  process.exit(1);
});
