// @ts-nocheck
"use strict";
const { PrismaClient } = require("../../../node_modules/@prisma/client");
const { PrismaPg } = require("../../../node_modules/@prisma/adapter-pg");
const { Pool } = require("../../../node_modules/pg");

const pool = new Pool({
  connectionString:
    "postgresql://routeflow:routeflow_prod_2026@gondola.proxy.rlwy.net:41006/routeflow",
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const startOfYear = new Date(2026, 0, 1);

  // ── 1. All 2026 invoices in RouteFlow (non-DRAFT/VOID/WRITTEN_OFF) ───────────
  const invoices = await prisma.invoice.findMany({
    where: {
      status: { notIn: ["DRAFT", "VOID", "WRITTEN_OFF"] },
      issueDate: { gte: startOfYear },
    },
    include: { customer: true, payments: true },
    orderBy: { invoiceNumber: "desc" },
  });

  console.log(`\n=== ROUTEFLOW 2026 INVOICES (non-DRAFT/VOID/WRITTEN_OFF) ===`);
  console.log(`Total count: ${invoices.length}`);
  const rfTotal = invoices.reduce((s, i) => s + Number(i.total), 0);
  console.log(`Total amount: ${rfTotal.toFixed(2)}`);

  console.log("\nInvoice# | Status   | issueDate  | Total    | Customer");
  console.log("-".repeat(80));
  for (const inv of invoices.slice(0, 30)) {
    const date = inv.issueDate ? inv.issueDate.toISOString().split("T")[0] : "null";
    const cust = (inv.customer?.businessName || "").substring(0, 25);
    console.log(
      `${inv.invoiceNumber.padEnd(9)} | ${inv.status.padEnd(8)} | ${date} | ${Number(inv.total).toFixed(2).padStart(8)} | ${cust}`,
    );
  }
  if (invoices.length > 30) {
    console.log(`... and ${invoices.length - 30} more`);
  }

  // ── 2. Outstanding invoices in RouteFlow ──────────────────────────────────
  const outstanding = await prisma.invoice.findMany({
    where: { status: { in: ["SENT", "VIEWED", "PARTIAL", "OVERDUE"] } },
    include: { customer: true, payments: true },
    orderBy: { invoiceNumber: "desc" },
  });

  let outstandingBalance = 0;
  console.log(`\n=== OUTSTANDING INVOICES IN ROUTEFLOW ===`);
  console.log(`Count: ${outstanding.length}`);
  for (const inv of outstanding) {
    const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
    const bal = Number(inv.total) - paid;
    if (bal > 0) {
      outstandingBalance += bal;
    }
  }
  console.log(`Total Outstanding Balance: ${outstandingBalance.toFixed(2)}`);

  // Show invoices with balance that are not this year
  const priorYear = outstanding.filter((inv) => inv.issueDate && inv.issueDate < startOfYear);
  if (priorYear.length > 0) {
    let priorBalance = 0;
    console.log(`\nOutstanding invoices from PRIOR YEARS (2025 and earlier):`);
    console.log("Invoice# | Status   | issueDate  | Total    | Paid     | Balance  | Customer");
    console.log("-".repeat(100));
    for (const inv of priorYear) {
      const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
      const bal = Number(inv.total) - paid;
      priorBalance += Math.max(0, bal);
      const date = inv.issueDate ? inv.issueDate.toISOString().split("T")[0] : "null";
      const cust = (inv.customer?.businessName || "").substring(0, 25);
      console.log(
        `${inv.invoiceNumber.padEnd(9)} | ${inv.status.padEnd(8)} | ${date} | ${Number(inv.total).toFixed(2).padStart(8)} | ${paid.toFixed(2).padStart(8)} | ${bal.toFixed(2).padStart(8)} | ${cust}`,
      );
    }
    console.log(`Total prior-year outstanding balance: ${priorBalance.toFixed(2)}`);
    console.log(`(This is NOT in Zoho's "This Year" amount due — explains Receivables gap)`);
  }

  // ── 3. What is max invoice number in RouteFlow? ───────────────────────────
  const maxInv = await prisma.invoice.findFirst({
    orderBy: { invoiceNumber: "desc" },
    select: { invoiceNumber: true, issueDate: true, status: true, total: true },
  });
  console.log(`\n=== HIGHEST INVOICE IN ROUTEFLOW ===`);
  console.log(
    `Number: ${maxInv?.invoiceNumber}, Date: ${maxInv?.issueDate?.toISOString().split("T")[0]}, Status: ${maxInv?.status}, Total: ${Number(maxInv?.total ?? 0).toFixed(2)}`,
  );

  // ── 4. DRAFT invoices in 2026 ─────────────────────────────────────────────
  const drafts = await prisma.invoice.findMany({
    where: {
      status: "DRAFT",
      issueDate: { gte: startOfYear },
    },
    include: { customer: true },
    orderBy: { invoiceNumber: "desc" },
  });
  console.log(`\n=== DRAFT INVOICES IN 2026 (excluded from sales) ===`);
  for (const inv of drafts) {
    const date = inv.issueDate ? inv.issueDate.toISOString().split("T")[0] : "null";
    console.log(
      `${inv.invoiceNumber} | ${date} | ${Number(inv.total).toFixed(2)} | ${inv.customer?.businessName}`,
    );
  }

  // ── 5. Breakdown: Zoho expects $164,299.29, RF has $163,120.29 ────────────
  console.log(`\n=== SALES GAP ANALYSIS ===`);
  console.log(`Zoho Total Sales:      $164,299.29`);
  console.log(`RouteFlow Total Sales: $163,120.29`);
  console.log(`Gap:                   $   1,179.00 (RouteFlow is LESS)`);
  console.log("");
  console.log(`Possible explanations:`);
  console.log(`1. Invoices in Zoho but NOT in RouteFlow (check highest invoice number above)`);
  console.log(`2. Some invoices imported as DRAFT in RF but SENT/PAID in Zoho`);
  console.log(`3. Tax amounts on some invoices (Zoho includes tax in total, RF may not)`);

  // Check if any invoice status in RF differs from what Zoho would show
  // Show the gap more specifically — check if all INV-000xxx are in RF
  const allInvoiceNumbers = invoices.map((i) => i.invoiceNumber);
  const maxNumber = Math.max(...allInvoiceNumbers.map((n) => parseInt(n.replace("INV-", ""))));
  console.log(`\nHighest non-draft invoice number: INV-${String(maxNumber).padStart(6, "0")}`);
  console.log(`Check Zoho invoice list for any invoice numbers between your imports`);

  await prisma.$disconnect();
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
