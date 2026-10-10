// Run separately to seed default expense categories
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const CATEGORIES = [
  { name: "Fuel", code: "FUEL" },
  { name: "Vehicle Maintenance", code: "VEHICLE" },
  { name: "Labor / Wages", code: "LABOR" },
  { name: "Rent / Lease", code: "RENT" },
  { name: "Utilities", code: "UTILITIES" },
  { name: "Marketing", code: "MARKETING" },
  { name: "Insurance", code: "INSURANCE" },
  { name: "Other", code: "OTHER" },
];

async function main() {
  for (const cat of CATEGORIES) {
    // Global default category: tenantId IS NULL. Prisma's generated compound-unique filter type
    // for @@unique([tenantId, code]) requires a non-null tenantId (SQL treats NULL <> NULL in a
    // unique constraint, so the filter type can't express "the null row"), so upsert() can't
    // target this row at all -- findFirst + branch is the correct shape. A bare `where: { code }`
    // was never a real Prisma unique input either way; this never type-checked (B686: prisma/**
    // was excluded from tsc wholesale) and would have thrown at runtime.
    const existing = await prisma.expenseCategory.findFirst({
      where: { tenantId: null, code: cat.code },
    });
    if (existing) {
      await prisma.expenseCategory.update({ where: { id: existing.id }, data: { name: cat.name } });
    } else {
      await prisma.expenseCategory.create({ data: { name: cat.name, code: cat.code } });
    }
  }
  console.log("Expense categories seeded");
}
main().finally(() => prisma.$disconnect());
