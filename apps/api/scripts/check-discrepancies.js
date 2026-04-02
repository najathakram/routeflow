// @ts-nocheck
'use strict';
const { PrismaClient } = require('../../../node_modules/@prisma/client');
const { PrismaPg } = require('../../../node_modules/@prisma/adapter-pg');
const { Pool } = require('../../../node_modules/pg');

const pool = new Pool({ connectionString: 'postgresql://routeflow:routeflow_prod_2026@gondola.proxy.rlwy.net:41006/routeflow' });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  // ── 1. All outstanding invoices ────────────────────────────────────────────
  const outstanding = await prisma.invoice.findMany({
    where: { status: { in: ['SENT', 'OVERDUE', 'PARTIAL', 'VIEWED'] } },
    include: { customer: true, payments: true },
    orderBy: { customer: { businessName: 'asc' } }
  });

  let rfTotal = 0;
  console.log('\n=== ALL OUTSTANDING (SENT/OVERDUE/PARTIAL/VIEWED) INVOICES IN ROUTEFLOW ===');
  console.log('Invoice#         | Customer                          | Status   |    Total |     Paid |  Balance | DueDate');
  console.log('-'.repeat(120));
  for (const inv of outstanding) {
    const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
    const balance = Number(inv.total) - paid;
    if (balance <= 0.01) continue;
    rfTotal += balance;
    const ref = inv.payments.length ? inv.payments[0].reference || '' : '';
    console.log(`${inv.invoiceNumber.padEnd(16)} | ${(inv.customer.businessName||'').substring(0,33).padEnd(33)} | ${inv.status.padEnd(8)} | ${Number(inv.total).toFixed(2).padStart(8)} | ${paid.toFixed(2).padStart(8)} | ${balance.toFixed(2).padStart(8)} | ${inv.dueDate ? inv.dueDate.toISOString().split('T')[0] : 'none'} ${ref.includes('zoho-import') ? '[SYNTHETIC PMT]' : ''}`);
  }
  console.log('-'.repeat(120));
  console.log(`ROUTEFLOW TOTAL: $${rfTotal.toFixed(2)}`);
  console.log(`ZOHO TOTAL:      $23,526.80`);
  console.log(`DIFFERENCE:      $${(rfTotal - 23526.80).toFixed(2)}`);

  // ── 2. Payment stats ───────────────────────────────────────────────────────
  const synth = await prisma.invoicePayment.count({ where: { reference: 'zoho-import' } });
  const totalPmts = await prisma.invoicePayment.count();
  console.log(`\n=== PAYMENT STATS ===`);
  console.log(`Total: ${totalPmts} | Synthetic (zoho-import placeholder): ${synth} | Real imported: ${totalPmts - synth}`);

  // ── 3. Customers in Zoho AR but maybe not in RouteFlow ────────────────────
  console.log('\n=== ZOHO "CURRENT" CUSTOMERS — LOOKUP IN ROUTEFLOW ===');
  for (const name of ['Hilmy Nizam', 'PETRO MAX 1', 'Super One Store', 'Tiger Mart']) {
    const rows = await prisma.customer.findMany({
      where: { businessName: { contains: name.split(' ')[0], mode: 'insensitive' } },
      include: { invoices: { include: { payments: true }, orderBy: { issueDate: 'desc' } } }
    });
    if (!rows.length) {
      console.log(`  "${name}": CUSTOMER NOT FOUND in RouteFlow`);
    } else {
      for (const c of rows) {
        const outstandingInvs = c.invoices.filter(i => ['SENT','OVERDUE','PARTIAL','VIEWED'].includes(i.status));
        const outstandingBal = outstandingInvs.reduce((s,i) => {
          const paid = i.payments.reduce((ps,p) => ps + Number(p.amount), 0);
          return s + Math.max(0, Number(i.total) - paid);
        }, 0);
        console.log(`  "${c.businessName}": ${c.invoices.length} total invoices | Outstanding balance: $${outstandingBal.toFixed(2)} | Statuses: ${c.invoices.map(i=>i.status).join(',')}`);
      }
    }
  }

  // ── 4. Specific discrepant customers ──────────────────────────────────────
  console.log('\n=== DISCREPANT CUSTOMERS — ALL THEIR INVOICES ===');
  const discrepantNames = ['FLASH MART', 'Fuel Zone', '24/7 Stop', 'Lanka-Mex - Winkler', 'Blue Dream', 'TYMES GROCERY', 'Smoke Shop Station', 'Crossroad 021'];
  for (const name of discrepantNames) {
    const rows = await prisma.invoice.findMany({
      where: { customer: { businessName: { contains: name.split(' ')[0], mode: 'insensitive' } } },
      include: { customer: true, payments: true },
      orderBy: { issueDate: 'desc' }
    });
    if (!rows.length) { console.log(`  No invoices for "${name}"`); continue; }
    for (const inv of rows) {
      const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
      const balance = Number(inv.total) - paid;
      const refs = inv.payments.map(p => p.reference).join(',');
      console.log(`  ${inv.invoiceNumber} | ${inv.customer.businessName} | ${inv.status} | total:$${Number(inv.total).toFixed(2)} | paid:$${paid.toFixed(2)} | bal:$${balance.toFixed(2)} | refs:[${refs}]`);
    }
  }
}

main().catch(console.error).finally(async () => { await prisma.$disconnect(); await pool.end(); });
