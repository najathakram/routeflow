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
    await prisma.expenseCategory.upsert({
      where: { code: cat.code },
      update: {},
      create: { name: cat.name, code: cat.code },
    });
  }
  console.log("Expense categories seeded");
}
main().finally(() => prisma.$disconnect());
