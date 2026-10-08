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
const { loadProtectedSlugs } = require("./lib/protected-slugs.cjs");
const { protectedTenantIds } = require("./lib/live-target-guard.cjs");

(async () => {
  // Row 195: never write a protected tenant (paying | stripe-linked | PROTECTED_TENANT_SLUGS).
  const slugs = loadProtectedSlugs(process.env, process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  const protectedIds = new Set(await protectedTenantIds(prisma, slugs));
  const expenses = await prisma.expense.findMany({
    where: { vendorBillId: { not: null } },
    select: {
      id: true,
      tenantId: true,
      vendorBillId: true,
      receivedAt: true,
      paidAt: true,
      createdAt: true,
    },
  });
  console.log(`Examining ${expenses.length} expenses linked to vendor bills...`);
  let paid = 0;
  let received = 0;
  let skippedProtected = 0;
  for (const e of expenses) {
    const bill = await prisma.vendorBill.findUnique({
      where: { id: e.vendorBillId },
      select: { status: true, receivedDate: true, tenantId: true },
    });
    if (!bill) continue;
    // NULL-tenantId expenses derive their tenant from the parent bill. Fail closed: skip when either
    // side is protected, or when neither side names a tenant (it cannot be shown to be unprotected).
    const owner = e.tenantId ?? bill.tenantId;
    if (
      !owner ||
      (e.tenantId && protectedIds.has(e.tenantId)) ||
      (bill.tenantId && protectedIds.has(bill.tenantId))
    ) {
      skippedProtected++;
      continue;
    }
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
  console.log(
    `protected-tenant guard: skipped ${skippedProtected} expense(s) of protected tenants or with no derivable tenant (fail closed).`,
  );
  await prisma.$disconnect();
})();
