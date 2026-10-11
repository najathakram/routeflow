/**
 * B1209 — real-Postgres pin that a walk-in's short tender is refused BEFORE anything is committed.
 *
 * The sale's total is only known inside OrdersService.create() (pricing, tax), so the counter sale passes create() a
 * `beforeWrite({ total })` hook (see counter-sale.service.ts) that runs after pricing and before the stock lock and
 * the transaction. This drives the REAL create() through the same `Object.create` harness as
 * counter-sale-replay.db.spec.ts with exactly that hook (assertLegsAgainstTotal): a short tender is a 400
 * COUNTER_TENDER_SHORT and leaves NO order, NO stock movement, NO invoice and NO payment row, and the stock is
 * untouched; an exact tender creates the order. NOT RUN by the authoring lane (no Postgres): the DB lane runs it
 * (`npm run local:test:db`, test tenant only, collected only by jest.db.config.js).
 */
jest.mock("../../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { EncryptionService } from "../../common/encryption.service";
import { SystemConfigService } from "../../system-config/system-config.service";
import { OrdersService } from "../orders.service";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import { assertLegsAgainstTotal } from "./counter-sale-legs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "B1209 — a walk-in short tender is refused before anything is written, real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: any;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-cs-tender-${run}`, "counter-sale-walk-in-tender.db.spec.ts");
    let tenantId = "";
    let operatorId = "";
    let customerId = "";
    let customerUserId = "";
    const productIds: string[] = [];

    async function plainProduct(): Promise<string> {
      const p = await raw.product.create({
        data: {
          name: `plain ${randomUUID().slice(0, 6)} ${run}`,
          unit: "each",
          pricePerUnit: "2.50",
          currentStock: 100,
          tenantId,
        },
      });
      productIds.push(p.id);
      return p.id;
    }

    const staff = (): JwtPayload =>
      ({
        sub: operatorId,
        username: "operator",
        role: "OPERATOR",
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId,
        tenantSlug: slug,
      }) as JwtPayload;

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      const systemConfig = new SystemConfigService(
        prisma,
        new EncryptionService({ get: () => undefined } as any),
      );
      orders = Object.assign(Object.create(OrdersService.prototype), {
        prisma,
        gateway: { emitOrderCreated: jest.fn(), emitUrgentOrder: jest.fn() },
        systemConfig,
        entitlements: { hasFlag: async () => true },
        sellingRestrictions: { assertLinesSellable: async () => undefined },
        authGuard: { assertAuthorizedOrThrow: async () => undefined },
        promotionsService: { activeForCatalog: async () => [] },
        ledger: {},
        tenantCtx,
        logger: new Logger(OrdersService.name),
      });
      tenantId = (await raw.tenant.create({ data: { slug, name: `CS tender ${slug}` } })).id;
      operatorId = (
        await raw.user.create({
          data: {
            email: `op-${run}@example.test`,
            username: `op-${run}`,
            role: "OPERATOR",
            tenantId,
          },
        })
      ).id;
      customerUserId = (
        await raw.user.create({
          data: {
            email: `c-${run}@example.test`,
            username: `c-${run}`,
            role: "CUSTOMER",
            tenantId,
          },
        })
      ).id;
      customerId = (
        await raw.customer.create({
          data: {
            userId: customerUserId,
            businessName: "cs tender co",
            contactName: "Tester",
            tenantId,
          },
        })
      ).id;
    }, 120_000);

    afterAll(async () => {
      const ids = (await raw.order.findMany({ where: { tenantId }, select: { id: true } })).map(
        (o) => o.id,
      );
      await raw.orderIdempotencyKey.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
      await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
      await raw.orderItem.deleteMany({ where: { orderId: { in: ids } } });
      await raw.order.deleteMany({ where: { id: { in: ids } } });
      await raw.product.deleteMany({ where: { id: { in: productIds } } });
      await raw.customer.deleteMany({ where: { id: customerId } });
      await raw.systemConfig.deleteMany({ where: { tenantId } });
      await raw.user.deleteMany({ where: { id: { in: [operatorId, customerUserId] } } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    const ring = (
      productId: string,
      amount: number | undefined,
      key = `cs-tender-${randomUUID()}`,
      hook?: jest.Mock,
    ) =>
      tenantCtx.run(tenantId, () =>
        orders.create(
          {
            customerId,
            items: [{ productId, qty: 3 }],
            idempotencyKey: key,
          },
          staff(),
          {
            skipAutoMerge: true,
            counterSale: true,
            beforeWrite: ({ total }: { total: number }) => {
              hook?.(total);
              assertLegsAgainstTotal([{ method: "CASH", amount }], total, true);
            },
          },
        ),
      );
    const rows = async (productId: string) => ({
      orders: await raw.order.count({ where: { tenantId } }),
      moves: await raw.stockMovement.count({ where: { productId } }),
      invoices: await raw.invoice.count({ where: { tenantId } }),
      payments: await raw.payment.count({ where: { tenantId } }),
      stock: Number(
        (await raw.product.findUniqueOrThrow({ where: { id: productId } })).currentStock,
      ),
    });

    it("a tender below the server total: 400 COUNTER_TENDER_SHORT and no order / movement / invoice / payment, stock untouched", async () => {
      const productId = await plainProduct();
      const before = await rows(productId);
      await expect(ring(productId, 5)).rejects.toMatchObject({
        status: 400,
        response: { code: "COUNTER_TENDER_SHORT" },
      });
      expect(await rows(productId)).toEqual(before);
      expect(before.stock).toBe(100);
    });

    it("a same-key REPLAY of a committed sale with a short tender body: the hook never fires, the saved order returns, nothing is added", async () => {
      const productId = await plainProduct();
      const key = `cs-tender-${randomUUID()}`;
      const first = await ring(productId, 7.5, key);
      const afterFirst = await rows(productId);
      const hook = jest.fn();
      let replayed = false;
      const second = await tenantCtx.run(tenantId, () =>
        orders.create(
          { customerId, items: [{ productId, qty: 3 }], idempotencyKey: key },
          staff(),
          {
            skipAutoMerge: true,
            counterSale: true,
            onReplay: () => (replayed = true),
            beforeWrite: ({ total }: { total: number }) => {
              hook(total);
              assertLegsAgainstTotal([{ method: "CASH", amount: 1 }], total, true);
            },
          },
        ),
      );
      expect(replayed).toBe(true);
      expect(hook).not.toHaveBeenCalled();
      expect(second.id).toBe(first.id);
      expect(await rows(productId)).toEqual(afterFirst);
    });

    it("an exact tender (3 x 2.50 = 7.50) creates the order and takes the stock once", async () => {
      const productId = await plainProduct();
      const order = await ring(productId, 7.5);
      expect(Number(order.total)).toBe(7.5);
      const after = await rows(productId);
      expect(after.moves).toBe(1);
      expect(after.stock).toBe(97);
    });
  },
);
