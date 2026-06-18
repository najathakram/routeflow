/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * One-shot backfill: consolidate every customer's unassigned PENDING orders
 * into a single PENDING order. Mirrors OrdersService.mergeAllPendingForCustomer.
 *
 * Skips orders attached to a route run, with invoices, transactions, or
 * returns — those are part of an in-flight delivery flow.
 *
 * Idempotent: re-running after consolidation is a no-op.
 *
 * Usage:
 *   node apps/api/scripts/merge-pending-orders.js
 */
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  // Customers with more than one mergeable PENDING order.
  const groups = await prisma.order.groupBy({
    by: ["customerId"],
    where: {
      status: "PENDING",
      routeRunId: null,
      routeRunStopId: null,
      transaction: { is: null },
      invoices: { none: {} },
      returns: { none: {} },
    },
    _count: { _all: true },
    having: { customerId: { _count: { gt: 1 } } },
  });

  console.log(`${groups.length} customer(s) have >1 mergeable PENDING order.`);

  let mergedOrders = 0;
  let winners = 0;

  for (const g of groups) {
    const customerId = g.customerId;
    const orders = await prisma.order.findMany({
      where: {
        customerId,
        status: "PENDING",
        routeRunId: null,
        routeRunStopId: null,
        transaction: { is: null },
        invoices: { none: {} },
        returns: { none: {} },
      },
      include: {
        lineItems: { where: { status: { not: "CANCELLED" } } },
      },
      orderBy: { updatedAt: "desc" },
    });
    if (orders.length <= 1) continue;

    const [winner, ...losers] = orders;
    const winnerProductIds = new Set(winner.lineItems.map((li) => li.productId));

    const qtyAdditions = new Map();
    const newItemsByProductId = new Map();
    for (const loser of losers) {
      for (const li of loser.lineItems) {
        if (winnerProductIds.has(li.productId)) {
          qtyAdditions.set(li.productId, (qtyAdditions.get(li.productId) ?? 0) + Number(li.qty));
        } else {
          const existing = newItemsByProductId.get(li.productId);
          if (existing) {
            existing.qty += Number(li.qty);
          } else {
            newItemsByProductId.set(li.productId, {
              qty: Number(li.qty),
              unitPrice: Number(li.unitPrice),
              priceType: li.priceType,
              originalPrice: li.originalPrice !== null ? Number(li.originalPrice) : null,
              overrideReason: li.overrideReason,
              overriddenBy: li.overriddenBy,
              notes: li.notes,
              tenantId: li.tenantId ?? winner.tenantId,
            });
          }
        }
      }
    }

    // Read tax rate from this tenant's SystemConfig (falls back to 0).
    let taxRate = 0;
    if (winner.tenantId) {
      const taxRow = await prisma.systemConfig.findFirst({
        where: { tenantId: winner.tenantId, key: "settings.taxRate" },
      });
      if (taxRow?.value) taxRate = parseFloat(taxRow.value) || 0;
    }

    await prisma.$transaction(async (tx) => {
      for (const li of winner.lineItems) {
        const addQty = qtyAdditions.get(li.productId) ?? 0;
        if (addQty <= 0) continue;
        const newQty = Number(li.qty) + addQty;
        const newSubtotal = newQty * Number(li.unitPrice);
        await tx.orderItem.update({
          where: { id: li.id },
          data: { qty: newQty, subtotal: newSubtotal },
        });
      }

      for (const [productId, data] of newItemsByProductId.entries()) {
        await tx.orderItem.create({
          data: {
            orderId: winner.id,
            productId,
            qty: data.qty,
            unitPrice: data.unitPrice,
            subtotal: data.qty * data.unitPrice,
            status: "PENDING",
            priceType: data.priceType,
            originalPrice: data.originalPrice,
            overrideReason: data.overrideReason,
            overriddenBy: data.overriddenBy,
            notes: data.notes,
            tenantId: data.tenantId,
          },
        });
      }

      for (const loser of losers) {
        await tx.orderItem.deleteMany({ where: { orderId: loser.id } });
        await tx.order.delete({ where: { id: loser.id } });
      }

      const activeItems = await tx.orderItem.findMany({
        where: { orderId: winner.id, status: { not: "CANCELLED" } },
      });
      const subtotal = activeItems.reduce((s, li) => s + Number(li.subtotal), 0);
      const tax = subtotal * taxRate;
      await tx.order.update({
        where: { id: winner.id },
        data: { subtotal, tax, total: subtotal + tax },
      });
    });

    console.log(`  customer ${customerId}: merged ${losers.length} → winner ${winner.id}`);
    mergedOrders += losers.length;
    winners += 1;
  }

  console.log(
    `\nDone. Merged ${mergedOrders} order(s) into ${winners} winner(s) across ${groups.length} customer(s).`,
  );
  await prisma.$disconnect();
  await pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
