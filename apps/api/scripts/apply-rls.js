/**
 * Applies PostgreSQL Row-Level Security policies to all tenant-scoped tables.
 * Run: node apps/api/scripts/apply-rls.js
 */
const { Pool } = require("pg");
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const TENANT_TABLES = [
  "User",
  "Customer",
  "CustomerAddress",
  "CustomerPrice",
  "CustomerTag",
  "CustomerTagAssignment",
  "CustomerComment",
  "ContactPerson",
  "Driver",
  "Product",
  "Route",
  "RouteStop",
  "RouteCustomer",
  "RouteRun",
  "RouteRunStop",
  "DeliveryMutation",
  "Order",
  "OrderItem",
  "OrderTemplate",
  "OrderTemplateItem",
  "Transaction",
  "TransactionItem",
  "Payment",
  "Invoice",
  "InvoiceItem",
  "InvoicePayment",
  "PaymentCounter",
  "CreditNote",
  "Estimate",
  "EstimateItem",
  "RecurringInvoice",
  "RecurringInvoiceItem",
  "AdvancePayment",
  "Return",
  "ReturnItem",
  "Supplier",
  "PurchaseOrder",
  "PurchaseOrderItem",
  "VendorBill",
  "VendorBillItem",
  "BillPayment",
  "Expense",
  "ExpenseCategory",
  "ExpenseLineItem",
  "MileageRate",
  "StockMovement",
  "StockLot",
  "Message",
  "RefreshToken",
  "DeviceToken",
  "UserPreference",
  "ProductMapping",
];

async function applyRls() {
  const client = await pool.connect();
  try {
    let applied = 0;
    let skipped = 0;

    for (const table of TENANT_TABLES) {
      try {
        await client.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
        await client.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
        await client.query(`DROP POLICY IF EXISTS tenant_isolation ON "${table}"`);
        // Prisma uses camelCase column names directly (no snake_case mapping)
        await client.query(`
          CREATE POLICY tenant_isolation ON "${table}"
            USING (
              "tenantId"::text = current_setting('app.current_tenant_id', true)
              OR coalesce(current_setting('app.current_tenant_id', true), '') = ''
            )
        `);
        console.log(`  ✓ RLS enabled on "${table}"`);
        applied++;
      } catch (err) {
        if (err.code === "42P01") {
          // undefined_table — model not yet in DB
          console.log(`  ↷ Skipped "${table}" (table not found)`);
          skipped++;
        } else {
          console.warn(`  ✗ Error on "${table}": ${err.message}`);
          skipped++;
        }
      }
    }

    // Verify
    const { rows } = await client.query(
      `SELECT tablename, rowsecurity FROM pg_tables
       WHERE schemaname = 'public' AND rowsecurity = true
       ORDER BY tablename`,
    );
    console.log(`\nDone: ${applied} tables secured, ${skipped} skipped.`);
    console.log(`Tables with RLS (${rows.length}): ${rows.map((r) => r.tablename).join(", ")}`);
  } finally {
    client.release();
    await pool.end();
  }
}

applyRls().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
