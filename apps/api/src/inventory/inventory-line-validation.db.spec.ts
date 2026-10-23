/**
 * B1237 + B1238: inventory routes name their products and lines explicitly (real Postgres).
 *
 * - Receiving a purchase order with an item that is not on the order answers 400 naming that item and writes
 *   nothing (it used to answer 200 and silently skip the item).
 * - Reorder settings on a product id that does not resolve in the caller's catalog answer 404 and write
 *   nothing (it used to surface a raw Prisma error as a 500).
 * - Fences: a valid receive and a valid reorder update still work.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`). Throwaway `qa-inv-lines-<run>-a|b` slugs
 * (assertTestTenant); `afterAll` deletes what the run created, in FK order.
 */
jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest.fn(() => ({ messages: { create: jest.fn() } })),
}));
jest.mock("sharp", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    rotate: jest.fn().mockReturnThis(),
    jpeg: jest.fn().mockReturnThis(),
    toBuffer: jest.fn(),
  })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("inventory routes refuse lines and products that do not resolve (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaService;
  let ctx: TenantContextService;
  let inventory: InventoryService;
  const catalogIds: string[] = [];
  let catalogA: string;
  let catalogB: string;
  let userA: string;
  let productA: string;
  let productB: string;
  let otherOnPo: string;
  let poId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StockAlertService,
          useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
        },
      ],
    }).compile();
    inventory = module.get(InventoryService);

    const mkCatalog = async (suffix: "a" | "b") => {
      const slug = assertTestTenant(
        `qa-inv-lines-${RUN}-${suffix}`,
        "inventory-line-validation.db.spec.ts",
      );
      const t = await prisma.tenant.create({ data: { slug, name: `inv lines ${slug}` } });
      catalogIds.push(t.id);
      return t.id;
    };
    catalogA = await mkCatalog("a");
    catalogB = await mkCatalog("b");
    const mkProduct = async (tenantId: string, tag: string) =>
      (
        await prisma.product.create({
          data: {
            tenantId,
            name: `${tag} ${RUN}`,
            unit: "ea",
            pricePerUnit: 10,
            currentStock: 10,
            averageCost: 3,
            costingMethod: "AVCO",
            reorderPoint: 4,
            reorderQty: 6,
          },
        })
      ).id;
    userA = (
      await prisma.user.create({
        data: {
          email: `${RUN}-a@example.invalid`,
          username: `qa-inv-lines-${RUN}-a`,
          role: "OPERATOR",
          tenantId: catalogA,
        },
      })
    ).id;
    const supplier = await prisma.supplier.create({
      data: { name: `Sup ${RUN}`, tenantId: catalogA },
    });
    productA = await mkProduct(catalogA, "prodA");
    otherOnPo = await mkProduct(catalogA, "prodA2");
    productB = await mkProduct(catalogB, "prodB");
    poId = (
      await prisma.purchaseOrder.create({
        data: {
          tenantId: catalogA,
          poNumber: `PO-IL-${RUN}`,
          supplierId: supplier.id,
          status: "SENT",
          totalAmount: 10,
          items: {
            create: [
              {
                tenantId: catalogA,
                productId: productA,
                qtyOrdered: 5,
                unitCost: 2,
                totalCost: 10,
              },
            ],
          },
        },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    const swallow = () => undefined;
    for (const tenantId of catalogIds) {
      const w = { where: { tenantId } };
      const poIds = (
        await prisma.purchaseOrder.findMany({ ...w, select: { id: true } }).catch(() => [])
      ).map((x) => x.id);
      await prisma.purchaseOrderItem.deleteMany({ where: { poId: { in: poIds } } }).catch(swallow);
      await prisma.purchaseOrder.deleteMany(w).catch(swallow);
      await prisma.stockLot.deleteMany(w).catch(swallow);
      await prisma.stockMovement.deleteMany(w).catch(swallow);
      await prisma.product.deleteMany(w).catch(swallow);
      await prisma.supplier.deleteMany(w).catch(swallow);
      await prisma.user.deleteMany(w).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
    await pool?.end();
  });

  async function snapshot() {
    const t = [catalogA, catalogB];
    const rows = async (sql: string) =>
      (await pool.query(sql, [t])).rows.map((r) => JSON.stringify(r));
    return {
      purchaseOrders: await rows(
        `SELECT id, status, "totalAmount" FROM "PurchaseOrder" WHERE "tenantId" = ANY($1) ORDER BY id`,
      ),
      purchaseOrderItems: await rows(
        `SELECT id, "productId", "qtyReceived" FROM "PurchaseOrderItem" WHERE "tenantId" = ANY($1) ORDER BY id`,
      ),
      movements: await rows(
        `SELECT id FROM "StockMovement" WHERE "tenantId" = ANY($1) ORDER BY id`,
      ),
      lots: await rows(`SELECT id FROM "StockLot" WHERE "tenantId" = ANY($1) ORDER BY id`),
      products: await rows(
        `SELECT to_jsonb(p) AS p FROM "Product" p WHERE p."tenantId" = ANY($1) ORDER BY p.id`,
      ),
    };
  }

  const asA = <T>(fn: () => Promise<T>) => ctx.run(catalogA, fn);
  const statusOf = (call: () => Promise<unknown>) =>
    asA(call).then(
      () => "RESOLVED",
      (e: any) =>
        typeof e?.getStatus === "function" ? e.getStatus() : `raw ${e?.constructor?.name}`,
    );

  it("B1237: receiving an item that is not on the PO answers 400 naming it and writes nothing", async () => {
    const before = await snapshot();
    let message = "";
    const status = await statusOf(() =>
      inventory
        .receivePurchaseOrder(poId, { items: [{ productId: otherOnPo, receivedQty: 3 }] }, userA)
        .catch((e) => {
          message = String(e?.message ?? "");
          throw e;
        }),
    );
    expect({ status, namesItem: message.includes(otherOnPo), after: await snapshot() }).toEqual({
      status: 400,
      namesItem: true,
      after: before,
    });
  }, 60_000);

  it("B1237: one unknown item among valid ones refuses the whole receive", async () => {
    const before = await snapshot();
    const status = await statusOf(() =>
      inventory.receivePurchaseOrder(
        poId,
        {
          items: [
            { productId: productA, receivedQty: 2 },
            { productId: otherOnPo, receivedQty: 3 },
          ],
        },
        userA,
      ),
    );
    expect({ status, after: await snapshot() }).toEqual({ status: 400, after: before });
  }, 60_000);

  it("fence: receiving an item that is on the PO still posts the receipt", async () => {
    const qtyReceived = async () =>
      Number(
        (await prisma.purchaseOrderItem.findFirstOrThrow({ where: { poId, productId: productA } }))
          .qtyReceived,
      );
    const before = await qtyReceived();
    await asA(() =>
      inventory.receivePurchaseOrder(
        poId,
        { items: [{ productId: productA, receivedQty: 2 }] },
        userA,
      ),
    );
    expect((await qtyReceived()) - before).toEqual(2);
  }, 60_000);

  it.each([
    ["an id that does not exist", () => randomUUID()],
    ["a product of the other catalog", () => productB],
  ])(
    "B1238: reorder settings on %s answer 404 and write nothing",
    async (_n, pick) => {
      const before = await snapshot();
      const id = pick();
      const status = await statusOf(() => inventory.setReorderPoint(id, 99, 99));
      expect({ status, after: await snapshot() }).toEqual({ status: 404, after: before });
    },
    60_000,
  );

  it("fence: reorder settings on a product in the caller's catalog still update", async () => {
    const updated: any = await asA(() => inventory.setReorderPoint(productA, 7, 9));
    expect([Number(updated.reorderPoint), Number(updated.reorderQty)]).toEqual([7, 9]);
  }, 60_000);
});
