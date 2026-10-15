/**
 * Row 466 — the SERVER half of "the clerk retries after a failed invoice step".
 *
 * createSale commits the order, then builds its invoice. When the invoice step throws, the API answers
 * with SALE_INVOICE_CREATE_FAILED + orderId. A retry with the SAME Idempotency-Key must not write a
 * second order: create() finds the stored order by (tenantId, idempotencyKey) and createSale resumes
 * from there (one stock decrement, the invoice built and sent once). Real OrdersService.create() and
 * createSale on real Postgres; only the invoice pipeline is a fake that fails ONCE.
 *
 * Both entry points reach this code: POST /orders/sell passes dto.idempotencyKey, and the counter
 * sale (CounterSaleService) calls createSale with the same key plus { counterSale, fulfillPath: PICKUP }.
 * Test tenant only (assertTestTenant); run via `npm run local:test:db` or jest.db.config.js.
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { EncryptionService } from "../common/encryption.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { OrdersService } from "./orders.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("row 466 — a createSale retry with the same key after a failed invoice step", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-r466-${run}`, "create-sale-same-key-retry.db.spec.ts");
  let tenantId = "";
  let operatorId = "";
  let customerUserId = "";
  let customerId = "";
  let productId = "";
  const productIds: string[] = [];
  const invoices = {
    createInvoiceFromOrder: jest.fn(),
    send: jest.fn(),
  };

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
      invoicesService: invoices,
      logger: new Logger(OrdersService.name),
    });
    tenantId = (await raw.tenant.create({ data: { slug, name: `R466 ${slug}` } })).id;
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
        data: { userId: customerUserId, businessName: "r466 co", contactName: "Tester", tenantId },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    const ids = (await raw.order.findMany({ where: { tenantId }, select: { id: true } })).map(
      (o) => o.id,
    );
    await raw.orderIdempotencyKey.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
    await raw.auditLog.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
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

  beforeEach(() => {
    invoices.createInvoiceFromOrder.mockReset();
    invoices.send.mockReset();
    invoices.send.mockImplementation(async (id: string) => ({ id, status: "SENT" }));
  });

  // A fresh product per test, so its stock movements are exactly this test's.
  async function freshProduct() {
    const p = await raw.product.create({
      data: {
        name: `Widget ${randomUUID().slice(0, 6)} ${run}`,
        unit: "each",
        pricePerUnit: "2.50",
        currentStock: 100,
        tenantId,
      },
    });
    productIds.push(p.id);
    productId = p.id;
  }
  beforeEach(freshProduct);

  const sale = (key: string) => ({
    customerId,
    items: [{ productId, qty: 2 }],
    deliveredNow: true,
    idempotencyKey: key,
  });
  const ring = (key: string, options: Record<string, unknown> = {}) =>
    tenantCtx.run(tenantId, () => orders.createSale(sale(key) as never, staff(), options));
  const failed = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e) => e,
    );

  it.each([
    ["POST /orders/sell (key in the DTO)", {}],
    ["the counter sale (PICKUP + counterSale)", { counterSale: true, fulfillPath: "PICKUP" }],
  ])(
    "%s: SALE_INVOICE_CREATE_FAILED, then the same key resumes the ONE order and finishes the invoice",
    async (_name, options) => {
      const key = `r466-${randomUUID()}`;
      invoices.createInvoiceFromOrder
        .mockRejectedValueOnce(new Error("invoice step down"))
        .mockResolvedValue([{ id: "inv-1", status: "DRAFT", createdAt: new Date(1) }]);

      const err = await failed(ring(key, options));
      const stored = await raw.order.findMany({ where: { tenantId, idempotencyKey: key } });
      expect(stored).toHaveLength(1);
      expect(err?.getResponse()).toMatchObject({
        code: "SALE_INVOICE_CREATE_FAILED",
        orderId: stored[0].id,
      });
      expect(invoices.send).not.toHaveBeenCalled();

      const result = await ring(key, options);

      // Same order, no second row, one stock decrement, the invoice built and sent once.
      expect(await raw.order.count({ where: { tenantId, idempotencyKey: key } })).toBe(1);
      expect(result).toMatchObject({ id: "inv-1" });
      expect(invoices.createInvoiceFromOrder).toHaveBeenCalledTimes(2);
      expect(invoices.createInvoiceFromOrder.mock.calls[1][0]).toBe(stored[0].id);
      expect(invoices.send).toHaveBeenCalledTimes(1);
      const moves = await raw.stockMovement.findMany({
        where: { productId, type: "SALE" },
      });
      expect(moves).toHaveLength(1);
      expect(
        Number((await raw.product.findUniqueOrThrow({ where: { id: productId } })).currentStock),
      ).toBe(98);
      const order = await raw.order.findUniqueOrThrow({ where: { id: stored[0].id } });
      expect(order.status).toBe("DELIVERED");
    },
    60_000,
  );

  it("a different key is a different sale (the guard is the key, not the customer)", async () => {
    invoices.createInvoiceFromOrder.mockResolvedValue([
      { id: "inv-2", status: "DRAFT", createdAt: new Date(1) },
    ]);
    const a = `r466-a-${randomUUID()}`;
    const b = `r466-b-${randomUUID()}`;
    await ring(a);
    await ring(b);
    expect(await raw.order.count({ where: { tenantId, idempotencyKey: { in: [a, b] } } })).toBe(2);
  }, 60_000);
});
