/**
 * Backfill InvoicePayment records for PAID invoices that have none.
 * This fixes invoices imported from Zoho that had their status set to PAID
 * but no corresponding InvoicePayment records were created.
 *
 * Usage — Railway production:
 *   railway run node apps/api/scripts/backfill-invoice-payments.js
 *
 * Usage — custom DATABASE_URL:
 *   DATABASE_URL="postgresql://..." node apps/api/scripts/backfill-invoice-payments.js
 */

const { PrismaClient } = require("../../../node_modules/@prisma/client");
const { PrismaPg } = require("../../../node_modules/@prisma/adapter-pg");
const { Pool } = require("../../../node_modules/pg");

const dbUrl =
  process.env.DATABASE_PUBLIC_URL ||
  process.env.DATABASE_URL ||
  "postgresql://user:pass@localhost:5432/routeflow_dev";

const pool = new Pool({ connectionString: dbUrl });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("💳  Backfill Invoice Payments");
  console.log(`   Database: ${dbUrl.replace(/:([^:@]+)@/, ":***@")}`);
  console.log("");

  // Find all PAID invoices with no payment records
  const paidWithNoPayments = await prisma.invoice.findMany({
    where: {
      status: "PAID",
      payments: { none: {} },
    },
    select: { id: true, invoiceNumber: true, total: true, paidAt: true, issueDate: true },
  });

  console.log(`📋 Found ${paidWithNoPayments.length} PAID invoices with no payment records`);

  if (paidWithNoPayments.length === 0) {
    console.log("✅ Nothing to backfill.");
    return;
  }

  let created = 0;
  let failed = 0;

  for (const inv of paidWithNoPayments) {
    try {
      await prisma.invoicePayment.create({
        data: {
          invoiceId: inv.id,
          amount: inv.total,
          method: "OTHER",
          reference: "zoho-import",
          notes: "Backfilled from Zoho import — payment recorded in Zoho",
          createdAt: inv.paidAt || inv.issueDate || new Date(),
        },
      });
      created++;
      console.log(`  ✓ ${inv.invoiceNumber} — $${Number(inv.total).toFixed(2)}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${inv.invoiceNumber}: ${e.message}`);
    }
  }

  console.log(`\n✨ Done: ${created} payment records created, ${failed} failed.`);
}

main()
  .catch((e) => {
    console.error("❌ Backfill failed:", e.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
