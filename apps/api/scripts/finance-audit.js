// @ts-nocheck
'use strict';
const { PrismaClient } = require('../../../node_modules/@prisma/client');
const { PrismaPg } = require('../../../node_modules/@prisma/adapter-pg');
const { Pool } = require('../../../node_modules/pg');

const pool = new Pool({ connectionString: 'postgresql://routeflow:routeflow_prod_2026@gondola.proxy.rlwy.net:41006/routeflow' });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);

  console.log('=== ROUTEFLOW FINANCE AUDIT ===');
  console.log('Date range: ', startOfYear.toISOString().split('T')[0], ' to ', now.toISOString().split('T')[0]);
  console.log('');

  // ─── SALES ────────────────────────────────────────────────────────────────
  // RouteFlow uses: invoice.total (which is totalAmount), issueDate, notIn DRAFT/VOID/WRITTEN_OFF
  const salesResult = await prisma.invoice.aggregate({
    where: {
      status: { notIn: ['DRAFT', 'VOID', 'WRITTEN_OFF'] },
      issueDate: { gte: startOfYear },
    },
    _sum: { total: true },
    _count: true,
  });
  const salesByStatus = await prisma.invoice.groupBy({
    by: ['status'],
    where: { issueDate: { gte: startOfYear } },
    _count: true,
    _sum: { total: true },
  });

  console.log('=== SALES ===');
  console.log('Total Sales (excl DRAFT/VOID/WRITTEN_OFF):', Number(salesResult._sum.total ?? 0).toFixed(2));
  console.log('Invoice count:', salesResult._count);
  console.log('By Status:');
  for (const s of salesByStatus.sort((a,b) => Number(b._sum.total) - Number(a._sum.total))) {
    console.log(`  ${s.status.padEnd(15)} count=${s._count} total=${Number(s._sum.total ?? 0).toFixed(2)}`);
  }

  // Check if there's a "subtotalAmount" vs "total" difference (tax)
  const taxCheck = await prisma.invoice.aggregate({
    where: {
      status: { notIn: ['DRAFT', 'VOID', 'WRITTEN_OFF'] },
      issueDate: { gte: startOfYear },
    },
    _sum: { total: true, discount: true, subtotal: true },
  });
  console.log('\nTax breakdown:');
  console.log('  Subtotal (excl discount):', Number(taxCheck._sum.subtotal ?? 0).toFixed(2));
  console.log('  Discount:                ', Number(taxCheck._sum.discount ?? 0).toFixed(2));
  console.log('  Total (incl tax):   ', Number(taxCheck._sum.total ?? 0).toFixed(2));

  // ─── CREDIT NOTES ────────────────────────────────────────────────────────
  const creditNotes = await prisma.creditNote.aggregate({
    where: {
      status: { in: ['ISSUED', 'APPLIED'] },
      createdAt: { gte: startOfYear },
    },
    _sum: { amount: true },
    _count: true,
  });
  console.log('\n=== CREDIT NOTES ===');
  console.log('Total Credit Notes (active):', Number(creditNotes._sum.amount ?? 0).toFixed(2));
  console.log('Count:', creditNotes._count);
  console.log('Net Sales (sales - credit notes):', (Number(taxCheck._sum.total ?? 0) - Number(creditNotes._sum.amount ?? 0)).toFixed(2));

  // ─── PAYMENTS/RECEIPTS ────────────────────────────────────────────────────
  // RouteFlow uses createdAt on invoicePayment table
  const paymentsResult = await prisma.invoicePayment.aggregate({
    where: { createdAt: { gte: startOfYear } },
    _sum: { amount: true },
    _count: true,
  });
  // Also check by payment date — are there old payments (pre-2026) that were added?
  const allTimePayments = await prisma.invoicePayment.aggregate({
    _sum: { amount: true },
    _count: true,
  });
  const syntheticPayments = await prisma.invoicePayment.count({
    where: { reference: 'zoho-import' },
  });
  console.log('\n=== PAYMENTS/RECEIPTS ===');
  console.log('Payments with createdAt >= startOfYear:', Number(paymentsResult._sum.amount ?? 0).toFixed(2), '(count:', paymentsResult._count, ')');
  console.log('All-time payments total:', Number(allTimePayments._sum.amount ?? 0).toFixed(2), '(count:', allTimePayments._count, ')');
  console.log('Synthetic (zoho-import) payments remaining:', syntheticPayments);

  // Check for payments with createdAt before this year
  const oldPayments = await prisma.invoicePayment.aggregate({
    where: { createdAt: { lt: startOfYear } },
    _sum: { amount: true },
    _count: true,
  });
  console.log('Payments with createdAt BEFORE this year:', Number(oldPayments._sum.amount ?? 0).toFixed(2), '(count:', oldPayments._count, ')');

  // ─── EXPENSES ─────────────────────────────────────────────────────────────
  const expensesResult = await prisma.expense.aggregate({
    where: { deletedAt: null, date: { gte: startOfYear } },
    _sum: { amount: true },
    _count: true,
  });
  const allExpenses = await prisma.expense.aggregate({
    where: { deletedAt: null },
    _sum: { amount: true },
    _count: true,
  });
  console.log('\n=== EXPENSES ===');
  console.log('Expenses this year (date >= startOfYear):', Number(expensesResult._sum.amount ?? 0).toFixed(2), '(count:', expensesResult._count, ')');
  console.log('All-time expenses total:', Number(allExpenses._sum.amount ?? 0).toFixed(2), '(count:', allExpenses._count, ')');

  // Top expense categories
  const expensesByCat = await prisma.expense.groupBy({
    by: ['categoryId'],
    where: { deletedAt: null, date: { gte: startOfYear } },
    _sum: { amount: true },
    _count: true,
  });
  const categories = await prisma.expenseCategory.findMany();
  const catMap = Object.fromEntries(categories.map(c => [c.id, c.name]));
  console.log('By category:');
  for (const e of expensesByCat.sort((a,b) => Number(b._sum.amount) - Number(a._sum.amount))) {
    console.log(`  ${(catMap[e.categoryId]||e.categoryId).padEnd(30)} count=${e._count} total=${Number(e._sum.amount ?? 0).toFixed(2)}`);
  }

  // ─── RECEIVABLES ──────────────────────────────────────────────────────────
  const receivables = await prisma.invoice.findMany({
    where: { status: { in: ['SENT', 'VIEWED', 'PARTIAL', 'OVERDUE'] } },
    include: { payments: true },
  });
  let totalReceivables = 0;
  for (const inv of receivables) {
    const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
    const bal = Number(inv.total) - paid;
    if (bal > 0) totalReceivables += bal;
  }
  console.log('\n=== RECEIVABLES (outstanding balance) ===');
  console.log('Total Receivables:', totalReceivables.toFixed(2));
  console.log('Open invoice count:', receivables.length);

  // Also check total of open invoices
  const openInvoicesTotal = await prisma.invoice.aggregate({
    where: { status: { in: ['SENT', 'VIEWED', 'PARTIAL', 'OVERDUE'] } },
    _sum: { total: true },
    _count: true,
  });
  console.log('Sum of total field (open invs):', Number(openInvoicesTotal._sum.total ?? 0).toFixed(2));
  console.log('(Difference = total payments against open invoices)');

  // ─── VENDOR BILLS (Purchases) ─────────────────────────────────────────────
  const vendorBills = await prisma.vendorBill.aggregate({
    where: {
      status: { notIn: ['DRAFT', 'VOID'] },
      billDate: { gte: startOfYear },
    },
    _sum: { totalOwed: true },
    _count: true,
  });
  console.log('\n=== VENDOR BILLS (YTD) ===');
  console.log('Total Vendor Bills:', Number(vendorBills._sum.totalOwed ?? 0).toFixed(2), '(count:', vendorBills._count, ')');

  // ─── INVOICE FIELD CHECK ───────────────────────────────────────────────────
  // Check if issueDate == invoiceDate or they can differ
  const sampleInvoices = await prisma.invoice.findMany({
    take: 5,
    orderBy: { createdAt: 'desc' },
    select: { invoiceNumber: true, issueDate: true, createdAt: true, total: true, status: true },
  });
  console.log('\n=== SAMPLE INVOICES (recent 5) ===');
  console.log('invoiceNumber    | issueDate  | createdAt  | total    | status');
  for (const inv of sampleInvoices) {
    const iDate = inv.issueDate ? inv.issueDate.toISOString().split('T')[0] : 'null';
    const created = inv.createdAt ? inv.createdAt.toISOString().split('T')[0] : 'null';
    console.log(`${inv.invoiceNumber.padEnd(16)} | ${iDate} | ${created} | ${Number(inv.total).toFixed(2).padStart(8)} | ${inv.status}`);
  }

  await prisma.$disconnect();
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
