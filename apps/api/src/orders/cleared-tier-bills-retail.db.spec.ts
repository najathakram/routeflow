/**
 * SA-1092 QT-6. A stored tier of 0 is "no price of its own": a Tier 2 customer on a product whose Tier 2 was cleared
 * bills Retail, never 0. Real Postgres, through the real BuyerController.createOrder and OrdersService.create. A second
 * product with a real Tier 2 proves the customer is priced at Tier 2.
 *
 * SAFETY: one throwaway `qa-sa1092-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes exactly the rows
 * this run created, in FK order.
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { _resetLockPoolForTests } from "../common/db-locks";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { BuyerController } from "../buyer/buyer.controller";
import { OrdersService } from "./orders.service";
import { INVOICE_EDIT_STUBS } from "./testing/invoice-edit-stubs";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("SA-1092 QT-6: a cleared tier bills Retail, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  let controller: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-sa1092-${run}`, "cleared-tier-bills-retail.db.spec.ts");
  let tenantId = "";
  let buyerUserId = "";
  let operatorUserId = "";
  let customerId = "";
  let clearedId = "";
  let pricedId = "";

  const buyerCtx = () => ({
    customerId,
    tenantId,
    tenantSlug: slug,
    userId: buyerUserId,
    customer: { id: customerId, businessName: `Acme ${run}` },
  });
  const operator = (): JwtPayload =>
    ({
      sub: operatorUserId,
      username: `op-${run}`,
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    }) as JwtPayload;

  const ITEMS = () => [
    { productId: clearedId, qty: 2 },
    { productId: pricedId, qty: 1 },
  ];

  /** Each product's one billed line, from the stored order. */
  async function billed() {
    const order = await raw.order.findFirstOrThrow({
      where: { tenantId },
      include: { lineItems: true },
    });
    const line = (id: string) => {
      const l = order.lineItems.find((x) => x.productId === id)!;
      return { unitPrice: Number(l.unitPrice), subtotal: Number(l.subtotal) };
    };
    return { cleared: line(clearedId), priced: line(pricedId), total: Number(order.total) };
  }

  const AT_RETAIL = {
    cleared: { unitPrice: 24, subtotal: 48 },
    priced: { unitPrice: 20, subtotal: 20 },
    total: 68,
  };

  async function wipe() {
    await raw.stockMovement.deleteMany({
      where: { productId: { in: [clearedId, pricedId].filter(Boolean) } },
    });
    await raw.orderItem.deleteMany({ where: { tenantId } });
    await raw.order.deleteMany({ where: { tenantId } });
  }

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
      gateway: {
        emitOrderCreated: jest.fn(),
        emitUrgentOrder: jest.fn(),
        emitOrderStatusChanged: jest.fn(),
        emitLowStock: jest.fn(),
      },
      notifications: {
        sendToCustomer: jest.fn().mockResolvedValue(undefined),
        sendToUser: jest.fn().mockResolvedValue(1),
      },
      messaging: { notifyEvent: jest.fn().mockResolvedValue(undefined) },
      systemConfig,
      featureConfig: { getEffectiveMode: async () => "on" },
      entitlements: { hasFlag: async () => true },
      sellingRestrictions: {
        getPolicy: async () => ({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
        assertLinesSellable: async () => undefined,
      },
      authGuard: { assertAuthorizedOrThrow: async () => undefined },
      promotionsService: { activeForCatalog: async () => [] },
      tenantCtx,
      invoicesService: {
        findOpenOrderDraft: async () => null,
        revertLinkedInvoicesForOrderEdit: async () => undefined,
        resyncOrderInvoicesForEdit: async () => [],
        ...INVOICE_EDIT_STUBS,
        reconcileOrderDraftInvoice: async () => undefined,
      },
      creditNotes: {
        validateSelectionsForCustomer: async () => undefined,
        settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }),
      },
      logger: new Logger(OrdersService.name),
      inlineReturns: {},
      oversellReader: { read: async () => ({ allowOversell: true }) },
    });
    controller = Object.assign(Object.create(BuyerController.prototype), {
      prisma,
      ordersService: orders,
      logger: new Logger("BuyerController"),
    });

    tenantId = (await raw.tenant.create({ data: { slug, name: `SA-1092 ${slug}` } })).id;
    buyerUserId = (
      await raw.user.create({
        data: { email: `b-${run}@example.test`, username: `b-${run}`, role: "CUSTOMER", tenantId },
      })
    ).id;
    operatorUserId = (
      await raw.user.create({
        data: { email: `o-${run}@example.test`, username: `o-${run}`, role: "OPERATOR", tenantId },
      })
    ).id;
    customerId = (
      await raw.customer.create({
        data: {
          userId: buyerUserId,
          businessName: `Acme ${run}`,
          contactName: "T",
          pricingTier: 2,
          tenantId,
        },
      })
    ).id;
    const product = async (name: string, priceTier2: string) =>
      (
        await raw.product.create({
          data: {
            name: `${name} ${run}`,
            unit: "Case",
            pricePerUnit: "24.00",
            priceTier2,
            currentStock: "1000",
            tenantId,
          },
        })
      ).id;
    clearedId = await product("Acme Cleared", "0");
    pricedId = await product("Acme Priced", "20.00");
  }, 120_000);

  beforeEach(async () => {
    await wipe();
  });

  afterAll(async () => {
    try {
      await wipe();
      await raw.auditLog.deleteMany({ where: { tenantId } });
      await raw.product.deleteMany({ where: { tenantId } });
      await raw.customer.deleteMany({ where: { tenantId } });
      await raw.user.deleteMany({ where: { tenantId } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
    } finally {
      await _resetLockPoolForTests();
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }
  }, 120_000);

  it("the buyer cart: the cleared tier bills 24, the priced tier 20", async () => {
    await tenantCtx.run(tenantId, () =>
      controller.createOrder({ items: ITEMS() }, buyerCtx(), `k-${run}-a`),
    );
    expect(await billed()).toEqual(AT_RETAIL);
  });

  it("a staff order: the cleared tier bills 24, the priced tier 20", async () => {
    await tenantCtx.run(tenantId, () =>
      orders.create({ customerId, items: ITEMS() }, operator(), { skipAutoMerge: true }),
    );
    expect(await billed()).toEqual(AT_RETAIL);
  });
});
