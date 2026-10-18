/**
 * B920 — real-Postgres proof that the buyer oversell check sums lines of the SAME product: two
 * order lines of 3 against 5 on hand, each ≤ available but 6 together, must be refused with the
 * coded INSUFFICIENT_STOCK 409 (staff text names ONE entry {available 5, requested 6}) and leave
 * `currentStock` and the stock ledger untouched; a staff caller still oversells (stock -1).
 * Through the REAL `decrementStockForSale` inside a real tenant transaction (row lock included).
 *
 * Run via `npm run local:test:db` (compose Postgres); collected only by jest.db.config.js. Test tenant
 * only (`qa-*`, enforced by assertTestTenant); afterAll deletes exactly the rows this run created.
 */
import { randomUUID } from "crypto";
import { ConflictException, Logger } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { CUSTOMER_INSUFFICIENT_STOCK_MESSAGE, decrementStockForSale } from "./order-stock";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("B920 — buyer oversell is per product — real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-b920-${run}`, "order-stock-b920.db.spec.ts");
  let tenantId = "";
  let productId = "";

  const sell = (qtys: number[], allowOversell: boolean, customerFacing = false) =>
    tenantCtx.run(tenantId, () =>
      prisma.tenantTransaction(async (tx: any) => {
        await decrementStockForSale(
          { logger: new Logger("order-stock-b920.db.spec"), tenantId },
          tx,
          qtys.map((qty) => ({ productId, qty })),
          allowOversell,
          { orderId: `b920-${run}`, notes: "CREATE", performedById: null, customerFacing },
        );
      }),
    );

  const stockNow = async () =>
    Number((await raw.product.findUniqueOrThrow({ where: { id: productId } })).currentStock);

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    tenantId = (await raw.tenant.create({ data: { slug, name: `B920 ${slug}` } })).id;
    productId = (
      await raw.product.create({
        data: {
          name: `Mango ${run}`,
          unit: "each",
          pricePerUnit: "1.00",
          currentStock: "5",
          tenantId,
        },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await raw.stockMovement.deleteMany({ where: { productId } });
    await raw.product.deleteMany({ where: { id: productId } });
    await raw.tenant.deleteMany({ where: { id: { in: [tenantId].filter(Boolean) } } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  // Each case starts from 5 on hand and an empty ledger, so a regression in one case can never
  // cascade into the next (they share ONE product).
  beforeEach(async () => {
    await raw.stockMovement.deleteMany({ where: { productId } });
    await raw.product.update({ where: { id: productId }, data: { currentStock: "5" } });
  });

  it("B920: two lines of 3 against 5 — a buyer gets the fixed 409 copy; stock and the ledger are untouched", async () => {
    let err: ConflictException | null = null;
    try {
      await sell([3, 3], false, true);
    } catch (e) {
      err = e as ConflictException;
    }
    expect(err).toBeInstanceOf(ConflictException);
    const body = err!.getResponse() as any;
    expect(body.code).toBe("INSUFFICIENT_STOCK");
    expect(body.message).toBe(CUSTOMER_INSUFFICIENT_STOCK_MESSAGE);
    expect(await stockNow()).toBe(5);
    expect(await raw.stockMovement.count({ where: { productId } })).toBe(0);
  });

  it("staff without oversell see ONE entry for the product total", async () => {
    let err: ConflictException | null = null;
    try {
      await sell([3, 3], false);
    } catch (e) {
      err = e as ConflictException;
    }
    expect(err).toBeInstanceOf(ConflictException);
    expect((err!.getResponse() as any).message).toContain("(available: 5, requested: 6)");
    expect(await stockNow()).toBe(5);
  });

  it("two lines that together fit (2 + 3 of 5) are accepted and stock reaches 0", async () => {
    await sell([2, 3], false);
    expect(await stockNow()).toBe(0);
  });

  it("staff behaviour unchanged: two lines of 3 against 5 oversell when allowed (stock -1)", async () => {
    await sell([3, 3], true);
    expect(await stockNow()).toBe(-1);
  });
});
