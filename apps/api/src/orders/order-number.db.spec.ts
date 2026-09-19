/**
 * DB-lane proof for `nextOrderNumberFor` (B587): the EXACT raw statement, bound through Prisma 7 +
 * the pg adapter, against a REAL Postgres — the unit specs only see a mocked `$queryRaw`.
 *
 * No FK fixtures: inside one interactive transaction a TEMP table named "Order" shadows the real
 * table (pg_temp is searched first), so the SQL runs unchanged over exactly the rows this file
 * inserts and nothing persists (ON COMMIT DROP). Collected only by `jest.db.config.js`
 * (`.db.spec.ts$`), run via `npm run local:test:db`; `requireLocalDatabaseUrl()` refuses any
 * non-local host.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { nextOrderNumberFor } from "./order-number";

describeDb("nextOrderNumberFor (db)", () => {
  const pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

  /** Runs `fn` against a temp "Order" holding `rows`, all inside one rolled-back transaction. */
  async function withOrders<T>(
    rows: Array<[tenantId: string, orderNumber: string]>,
    fn: (tx: PrismaClient) => Promise<T>,
  ): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `CREATE TEMP TABLE "Order" ("orderNumber" text, "tenantId" text) ON COMMIT DROP`,
      );
      for (const [tenantId, orderNumber] of rows) {
        await tx.$executeRawUnsafe(`INSERT INTO "Order" VALUES ($1, $2)`, orderNumber, tenantId);
      }
      return fn(tx as unknown as PrismaClient);
    });
  }

  const rows: Array<[string, string]> = [
    ["A", "ORD-SEED-1"], // sorts above every numeric number as text — the B587 poison
    ["A", "ORD-00001"],
    ["A", "ORD-00009"],
    ["A", "ORD-9"], // unpadded
    ["A", "ORD-1789012345678"], // 13-digit ORD-<epoch ms> from the template generator
    ["A", "ord-77"], // wrong case
    ["A", "ORD-12x"],
    ["B", "ORD-00500"],
  ];

  it("takes the NUMERIC max over conforming numbers only, ignoring seed/epoch/junk (no cast error)", async () => {
    await withOrders(rows, async (tx) => {
      await expect(nextOrderNumberFor(tx as never, "A")).resolves.toBe("ORD-00010");
    });
  });

  it("is tenant-scoped, and a null tenant sees every tenant (as the old lookup did)", async () => {
    await withOrders(rows, async (tx) => {
      await expect(nextOrderNumberFor(tx as never, "B")).resolves.toBe("ORD-00501");
      await expect(nextOrderNumberFor(tx as never, "C")).resolves.toBe("ORD-00001"); // no orders
      await expect(nextOrderNumberFor(tx as never, null)).resolves.toBe("ORD-00501");
    });
  });

  it("a tenant holding ONLY non-conforming numbers starts at ORD-00001 (the seeded-tenant repro)", async () => {
    await withOrders(
      [
        ["S", "ORD-SEED-1"],
        ["S", "ORD-SEED-2"],
      ],
      async (tx) => {
        await expect(nextOrderNumberFor(tx as never, "S")).resolves.toBe("ORD-00001");
      },
    );
  });

  it("the result then survives a second create: max+1 is itself conforming, so it advances", async () => {
    await withOrders([["S", "ORD-SEED-1"]], async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO "Order" VALUES ($1, $2)`, "ORD-00001", "S");
      await expect(nextOrderNumberFor(tx as never, "S")).resolves.toBe("ORD-00002");
    });
  });
});
