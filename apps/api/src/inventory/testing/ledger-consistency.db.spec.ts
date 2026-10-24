/**
 * X1 helper spec: `expectLedgerConsistent` passes on a consistent product and FAILS on planted
 * inconsistencies (a counter written without a movement, a stale newest stockAfter, no opening row).
 * SAFETY: one throwaway `qa-x1-<run>` tenant approved by `assertTestTenant`; afterAll deletes its rows.
 */
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import {
  endLedgerHelperPool,
  expectLedgerConsistent,
  ledgerViolations,
  seedOpeningRow,
} from "./ledger-consistency";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "X1 — expectLedgerConsistent: counter = Σ movements, newest stockAfter = counter",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-x1-${run}`, "ledger-consistency.db.spec.ts");
    let tenantId = "";
    const productIds: string[] = [];

    async function product(tag: string, currentStock: number): Promise<string> {
      const p = await raw.product.create({
        data: {
          name: `x1 ${tag} ${run}`,
          unit: "ea",
          pricePerUnit: "1.00",
          currentStock,
          tenantId,
        },
      });
      productIds.push(p.id);
      return p.id;
    }
    const sale = (productId: string, qty: number, stockAfter: number, offsetMs: number) =>
      raw.stockMovement.create({
        data: {
          productId,
          tenantId,
          type: "SALE",
          quantity: qty,
          stockAfter,
          notes: "CREATE",
          effectiveAt: new Date(Date.now() + offsetMs),
          createdAt: new Date(Date.now() + offsetMs),
        },
      });

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantId = (await raw.tenant.create({ data: { slug, name: `x1 ${slug}` } })).id;
    });

    afterAll(async () => {
      try {
        await raw.stockMovement.deleteMany({ where: { tenantId } });
        await raw.product.deleteMany({ where: { tenantId } });
        await raw.tenant.delete({ where: { id: tenantId } });
      } finally {
        await endLedgerHelperPool();
        await raw.$disconnect();
        await pool.end();
      }
    });

    it("passes on a consistent product: opening 10, sale −3, counter 7, newest stockAfter 7", async () => {
      const id = await product("ok", 7);
      await seedOpeningRow(pool, tenantId, id, 10);
      await sale(id, -3, 7, 1000);
      await expectLedgerConsistent(tenantId, [id], pool);
      await expectLedgerConsistent(tenantId, [id]); // and through its own default pool
    });

    it("FAILS when the counter moved without a movement (counter 4, ledger 7)", async () => {
      const id = await product("drift", 4);
      await seedOpeningRow(pool, tenantId, id, 10);
      await sale(id, -3, 7, 1000);
      expect(await ledgerViolations(tenantId, [id], pool)).toEqual([
        expect.objectContaining({
          productId: id,
          problem: "COUNTER_NE_LEDGER",
          currentStock: 4,
          ledgerSum: 7,
        }),
        expect.objectContaining({ productId: id, problem: "NEWEST_STOCKAFTER_NE_COUNTER" }),
      ]);
      await expect(expectLedgerConsistent(tenantId, [id], pool)).rejects.toThrow();
    });

    it("FAILS when the newest stockAfter is stale although the sum matches", async () => {
      const id = await product("stale", 7);
      await seedOpeningRow(pool, tenantId, id, 10);
      await sale(id, -3, 10, 1000); // sum is right, snapshot is not
      expect(await ledgerViolations(tenantId, [id], pool)).toEqual([
        expect.objectContaining({
          productId: id,
          problem: "NEWEST_STOCKAFTER_NE_COUNTER",
          newestStockAfter: [10],
        }),
      ]);
    });

    it("FAILS on a product with no opening row, and on a product of another tenant", async () => {
      const id = await product("noopen", 5);
      expect(await ledgerViolations(tenantId, [id], pool)).toEqual([
        expect.objectContaining({ productId: id, problem: "NO_OPENING_ROW" }),
      ]);
      expect(await ledgerViolations(randomUUID(), [id], pool)).toEqual([
        { productId: id, problem: "NOT_IN_TENANT" },
      ]);
    });
  },
);
