/**
 * Cleanup script — removes QA/dummy data.
 *
 * Usage:
 *   Targeted (recommended): node apps/api/scripts/cleanup-qa-data.js <manifest-file>
 *   Broad (dev only):       node apps/api/scripts/cleanup-qa-data.js --all
 *
 * With a manifest file, only the IDs recorded during that specific QA run
 * are deleted. This is safe for shared environments.
 *
 * With --all, it does a broad TRUNCATE (same as before). This must NOT
 * be used on environments with real data.
 *
 * Safety: Refuses to run when NODE_ENV=production.
 */

// ─── Production guard ─────────────────────────────────────────────────────────
if (process.env.NODE_ENV === "production") {
  console.error("\n❌ FATAL: cleanup-qa-data.js must NOT run against production.");
  console.error("   Set NODE_ENV to 'development' or 'staging' to proceed.\n");
  process.exit(1);
}

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

// ─── Parse arguments ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isAll = args.includes("--all");
const manifestPath = args.find((a) => !a.startsWith("--"));

if (!isAll && !manifestPath) {
  console.error("\n❌ Usage:");
  console.error("   Targeted: node cleanup-qa-data.js <qa-manifest-*.json>");
  console.error("   Broad:    node cleanup-qa-data.js --all");
  console.error("\n   Use --all only on dev environments with no real data.\n");
  process.exit(1);
}

// ─── Targeted cleanup (manifest-based) ────────────────────────────────────────

async function cleanupFromManifest(filePath) {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    console.error(`\n❌ Manifest file not found: ${absPath}`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(absPath, "utf8"));
  console.log(`\n📄 Loaded manifest from: ${absPath}`);
  console.log(`   Created at: ${manifest.createdAt}`);
  console.log(`   Tenant: ${manifest.tenantSlug}`);

  let totalDeleted = 0;

  // Delete in reverse dependency order: child entities first

  // Returns (via order IDs)
  if (manifest.orders?.length) {
    const r = await prisma.return.deleteMany({ where: { orderId: { in: manifest.orders } } });
    totalDeleted += r.count;
    console.log(`   ✓ Deleted ${r.count} returns`);
  }

  // Credit notes (via invoice → order)
  if (manifest.orders?.length) {
    const invoices = await prisma.invoice.findMany({
      where: { orderId: { in: manifest.orders } },
      select: { id: true },
    });
    if (invoices.length) {
      const invoiceIds = invoices.map((i) => i.id);
      const cn = await prisma.creditNote.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      totalDeleted += cn.count;
      console.log(`   ✓ Deleted ${cn.count} credit notes`);
    }
  }

  // Invoices
  if (manifest.orders?.length) {
    const inv = await prisma.invoice.deleteMany({ where: { orderId: { in: manifest.orders } } });
    totalDeleted += inv.count;
    console.log(`   ✓ Deleted ${inv.count} invoices`);
  }

  // Route runs
  if (manifest.routeRuns?.length) {
    const rrs = await prisma.routeRunStop.deleteMany({ where: { runId: { in: manifest.routeRuns } } });
    const rr = await prisma.routeRun.deleteMany({ where: { id: { in: manifest.routeRuns } } });
    totalDeleted += rrs.count + rr.count;
    console.log(`   ✓ Deleted ${rr.count} route runs (${rrs.count} stops)`);
  }

  // Routes
  if (manifest.routes?.length) {
    const rc = await prisma.routeCustomer.deleteMany({ where: { routeId: { in: manifest.routes } } });
    const rs = await prisma.routeStop.deleteMany({ where: { routeId: { in: manifest.routes } } });
    const rt = await prisma.route.deleteMany({ where: { id: { in: manifest.routes } } });
    totalDeleted += rc.count + rs.count + rt.count;
    console.log(`   ✓ Deleted ${rt.count} routes (${rs.count} stops, ${rc.count} customers)`);
  }

  // Orders
  if (manifest.orders?.length) {
    const oi = await prisma.orderItem.deleteMany({ where: { orderId: { in: manifest.orders } } });
    const o = await prisma.order.deleteMany({ where: { id: { in: manifest.orders } } });
    totalDeleted += oi.count + o.count;
    console.log(`   ✓ Deleted ${o.count} orders (${oi.count} items)`);
  }

  // Drivers
  if (manifest.drivers?.length) {
    const driverIds = manifest.drivers.map((d) => d.driverId || d);
    const d = await prisma.driver.deleteMany({ where: { id: { in: driverIds } } });
    totalDeleted += d.count;
    console.log(`   ✓ Deleted ${d.count} drivers`);
  }

  // Customers
  if (manifest.customers?.length) {
    const customerIds = manifest.customers.map((c) => c.customerId || c);
    const c = await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    totalDeleted += c.count;
    console.log(`   ✓ Deleted ${c.count} customers`);
  }

  // Products
  if (manifest.products?.length) {
    const p = await prisma.product.deleteMany({ where: { id: { in: manifest.products } } });
    totalDeleted += p.count;
    console.log(`   ✓ Deleted ${p.count} products`);
  }

  // Suppliers
  if (manifest.suppliers?.length) {
    const s = await prisma.supplier.deleteMany({ where: { id: { in: manifest.suppliers } } });
    totalDeleted += s.count;
    console.log(`   ✓ Deleted ${s.count} suppliers`);
  }

  // Users (customer + driver accounts)
  const userIds = [
    ...(manifest.customers || []).map((c) => c.userId).filter(Boolean),
    ...(manifest.drivers || []).map((d) => d.userId).filter(Boolean),
  ];
  if (userIds.length) {
    const u = await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    totalDeleted += u.count;
    console.log(`   ✓ Deleted ${u.count} user accounts`);
  }

  console.log(`\n✅ Manifest cleanup complete. ${totalDeleted} records deleted.`);
}

// ─── Broad cleanup (TRUNCATE all tables) ──────────────────────────────────────

async function cleanupAll() {
  console.log("\n🗑  Removing all QA dummy data (broad TRUNCATE)...\n");

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

  const deleted = await prisma.user.deleteMany({
    where: { role: { not: "OPERATOR" } },
  });
  console.log(`   ✓ Removed ${deleted.count} non-operator user accounts.`);

  const remaining = await prisma.user.findMany({ select: { username: true, role: true } });
  console.log(`\n✅ Broad cleanup complete. Remaining users:`);
  remaining.forEach((u) => console.log(`   - ${u.username} (${u.role})`));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (manifestPath) {
    await cleanupFromManifest(manifestPath);
  } else {
    await cleanupAll();
  }
}

main()
  .catch((err) => {
    console.error("\n❌ Cleanup failed:", err.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
