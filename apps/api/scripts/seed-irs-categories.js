/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * One-shot: seed the IRS Schedule C expense categories into every existing tenant.
 * Safe to run multiple times — uses skipDuplicates on (tenantId, code).
 *
 * Usage:
 *   node apps/api/scripts/seed-irs-categories.js
 */
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");
const { loadProtectedSlugs } = require("./lib/protected-slugs.cjs");
const { filterWritableTenants } = require("./lib/live-target-guard.cjs");

const IRS = [
  ["ADVERTISING", "Advertising"],
  ["CAR_AND_TRUCK", "Car and Truck"],
  ["COMMISSIONS_AND_FEES", "Commissions and Fees"],
  ["CONTRACT_LABOR", "Contract Labor"],
  ["DEPRECIATION", "Depreciation"],
  ["EMPLOYEE_BENEFITS", "Employee Benefits"],
  ["INSURANCE", "Insurance"],
  ["INTEREST", "Interest"],
  ["LEGAL_AND_PROFESSIONAL", "Legal and Professional"],
  ["OFFICE_EXPENSE", "Office Expense"],
  ["PENSION_AND_PROFIT_SHARING", "Pension and Profit-sharing"],
  ["RENT_OR_LEASE", "Rent or Lease"],
  ["REPAIRS_AND_MAINTENANCE", "Repairs and Maintenance"],
  ["SUPPLIES", "Supplies"],
  ["TAXES_AND_LICENSES", "Taxes and Licenses"],
  ["TRAVEL", "Travel"],
  ["MEALS", "Meals (50%)"],
  ["UTILITIES", "Utilities"],
  ["WAGES", "Wages"],
  ["OTHER_EXPENSES", "Other Expenses"],
];

(async () => {
  // Row 195: never write a protected tenant (paying | stripe-linked | PROTECTED_TENANT_SLUGS).
  // Loaded once, from the URL this script dials, before connecting.
  const slugs = loadProtectedSlugs(process.env, process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  const allTenants = await prisma.tenant.findMany({
    select: { id: true, slug: true, status: true, class: true, deletedAt: true },
  });
  const subs = new Map(
    (
      await prisma.tenantSubscription.findMany({
        select: { tenantId: true, planKey: true, stripeSubId: true },
      })
    ).map((s) => [s.tenantId, s]),
  );
  const { writable: tenants } = filterWritableTenants(allTenants, subs, slugs);
  let total = 0;
  for (const t of tenants) {
    const existing = await prisma.expenseCategory.findMany({
      where: { tenantId: t.id },
      select: { code: true },
    });
    const have = new Set(existing.map((c) => c.code));
    const rows = IRS.filter(([code]) => !have.has(code)).map(([code, name]) => ({
      tenantId: t.id,
      code,
      name,
      isCustom: false,
    }));
    if (rows.length) {
      await prisma.expenseCategory.createMany({ data: rows, skipDuplicates: true });
      console.log(`tenant ${t.id}: inserted ${rows.length}`);
      total += rows.length;
    }
  }
  console.log(`Done. Inserted ${total} category rows across ${tenants.length} writable tenants.`);
  await prisma.$disconnect();
})();
