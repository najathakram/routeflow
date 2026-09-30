import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { requireLocalDatabaseUrl, describeDb } from "./db-spec";

describeDb("db lane", () => {
  // Nothing env-dependent may run at collection time: Jest evaluates a `describe.skip`
  // body, so construction here would throw even when the lane is meant to be skipped.
  let pool: Pool;
  let prisma: PrismaClient;

  beforeAll(() => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
  });

  it("connects and runs a query against the local database", async () => {
    const rows = await prisma.$queryRaw`SELECT 1::int AS one`;
    expect(rows).toEqual([{ one: 1 }]);
  });
});
