/**
 * Backfill script: Generate Invoices for existing DELIVERED orders
 * that have Transactions but no linked Invoice.
 *
 * Prerequisites: API must be running on http://localhost:3000
 * Run from repo root: node apps/api/scripts/backfill-invoices.js
 */

const { PrismaClient } = require("../../../node_modules/@prisma/client");
const { PrismaPg } = require("../../../node_modules/@prisma/adapter-pg");
const { Pool } = require("../../../node_modules/pg");

const pool = new Pool({ connectionString: "postgresql://user:pass@localhost:5432/routeflow_dev" });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function generateInvoiceNumber(db) {
  const year = new Date().getFullYear();
  const prefix = `INV-${year}-`;
  const last = await db.invoice.findFirst({
    where: { invoiceNumber: { startsWith: prefix } },
    orderBy: { invoiceNumber: "desc" },
  });
  const seq = last ? parseInt(last.invoiceNumber.split("-")[2], 10) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, "0")}`;
}

async function main() {
  console.log("\n📋 Backfill — Creating Invoices for delivered orders without invoices...\n");

  // Find all DELIVERED orders that have no linked invoice
  const deliveredOrders = await prisma.order.findMany({
    where: {
      status: "DELIVERED",
      invoice: null, // no linked invoice
    },
    include: {
      lineItems: {
        where: { status: { not: "CANCELLED" } },
        include: { product: { select: { name: true } } },
      },
    },
  });

  console.log(`   Found ${deliveredOrders.length} delivered orders without invoices.\n`);

  let created = 0;
  let skipped = 0;

  for (const order of deliveredOrders) {
    // Double-check no invoice exists for this order
    const existing = await prisma.invoice.findFirst({ where: { orderId: order.id } });
    if (existing) {
      console.log(
        `   ⏭  Order ${order.orderNumber} already has invoice ${existing.invoiceNumber}`,
      );
      skipped++;
      continue;
    }

    if (order.lineItems.length === 0) {
      console.log(`   ⏭  Order ${order.orderNumber} has no active line items — skipping`);
      skipped++;
      continue;
    }

    const invoiceNumber = await generateInvoiceNumber(prisma);
    const dueDate = new Date(order.updatedAt);
    dueDate.setDate(dueDate.getDate() + 30);

    await prisma.invoice.create({
      data: {
        invoiceNumber,
        customerId: order.customerId,
        orderId: order.id,
        status: "SENT",
        sentAt: order.updatedAt,
        subtotal: Number(order.subtotal),
        taxAmount: Number(order.tax || 0),
        discount: 0,
        shippingFee: 0,
        total: Number(order.total),
        dueDate,
        issueDate: order.updatedAt,
        notes: order.orderNumber ? `Order #${order.orderNumber}` : null,
        items: {
          create: order.lineItems.map((li) => ({
            description: li.product?.name ?? "Product",
            productId: li.productId,
            qty: Number(li.qty),
            unitPrice: Number(li.unitPrice),
            discount: 0,
            taxRate: 0,
            subtotal: Number(li.subtotal),
          })),
        },
      },
    });

    console.log(
      `   ✅ Created ${invoiceNumber} for order ${order.orderNumber} (${order.lineItems.length} items, total: $${order.total})`,
    );
    created++;
  }

  console.log(`\n✅ Backfill complete: ${created} invoices created, ${skipped} skipped.\n`);

  await prisma.$disconnect();
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Backfill failed:", err);
  process.exit(1);
});
