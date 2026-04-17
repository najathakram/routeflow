/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * One-shot: derive Expense.status from the linked VendorBill for inventory purchases.
 * VendorBill.PAID     → Expense.status=PAID,     paidAt=createdAt if unset
 * VendorBill.RECEIVED → Expense.status=RECEIVED, receivedAt=createdAt if unset
 * Everything else stays PENDING.
 *
 * Usage:
 *   node apps/api/scripts/backfill-expense-status.js
 */
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  const expenses = await prisma.expense.findMany({
    where: { vendorBillId: { not: null } },
    select: { id: true, vendorBillId: true, receivedAt: true, paidAt: true, createdAt: true },
  });
  console.log(`Examining ${expenses.length} expenses linked to vendor bills...`);
  let paid = 0;
  let received = 0;
  for (const e of expenses) {
    const bill = await prisma.vendorBill.findUnique({
      where: { id: e.vendorBillId },
      select: { status: true, receivedDate: true },
    });
    if (!bill) continue;
    if (bill.status === "PAID") {
      await prisma.expense.update({
        where: { id: e.id },
        data: {
          status: "PAID",
          receivedAt: e.receivedAt ?? bill.receivedDate ?? e.createdAt,
          paidAt: e.paidAt ?? new Date(),
        },
      });
      paid++;
    } else if (bill.status === "RECEIVED" || bill.status === "PARTIAL") {
      await prisma.expense.update({
        where: { id: e.id },
        data: {
          status: "RECEIVED",
          receivedAt: e.receivedAt ?? bill.receivedDate ?? e.createdAt,
        },
      });
      received++;
    }
  }
  console.log(`Done. Marked ${paid} PAID and ${received} RECEIVED.`);
  await prisma.$disconnect();
})();
