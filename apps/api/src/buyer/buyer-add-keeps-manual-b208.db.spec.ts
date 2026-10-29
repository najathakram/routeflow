/**
 * B208 guard (SA-974, row 497 fixed it; this pins it). An operator's MANUAL price on a line survives a buyer ADDING
 * to the same order. Real Postgres, THROUGH the real BuyerController.createOrder -> foldMergeItems ->
 * OrdersService.updateOrderItems. The price comes from the stored, row-locked line, never the payload (B13).
 *
 *  - plain pack line: tier $5, stored MANUAL $4 x 10 (stamp + reason), buyer adds 2 -> qty 12 @ $4 = $48, MANUAL, stamp kept;
 *  - boxed twin: 12 a box, tier $12 a box, stored box-split line 1 box + 6 pieces at MANUAL $8 a box, buyer adds one
 *    box -> 2 boxes + 6 pieces at $8 = $20, MANUAL, stamp kept.
 *
 * SAFETY: one throwaway `qa-b208-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes exactly the rows
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
import { BuyerController } from "./buyer.controller";
import { OrdersService } from "../orders/orders.service";
import { INVOICE_EDIT_STUBS } from "../orders/testing/invoice-edit-stubs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "B208 — a buyer adding to an order keeps the operator's MANUAL price, real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: any;
    let controller: any;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-b208-${run}`, "buyer-add-keeps-manual-b208.db.spec.ts");
    let tenantId = "";
    let buyerUserId = "";
    let customerId = "";
    let productId = "";

    const ctx = () => ({
      customerId,
      tenantId,
      tenantSlug: slug,
      userId: buyerUserId,
      customer: { id: customerId, businessName: `Acme ${run}` },
    });
    const submit = (items: any[], extra: Record<string, unknown> = {}, key?: string) =>
      tenantCtx.run(tenantId, () => controller.createOrder({ items, ...extra }, ctx(), key));
    const orderCount = () => raw.order.count({ where: { tenantId } });
    const snapshot = async (orderId: string) => {
      const o = await raw.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { lineItems: { orderBy: { position: "asc" } } },
      });
      return {
        orderNumber: o.orderNumber,
        status: o.status,
        subtotal: Number(o.subtotal),
        total: Number(o.total),
        lines: o.lineItems.map((l) => ({
          productId: l.productId,
          qty: Number(l.qty),
          unitPrice: Number(l.unitPrice),
          subtotal: Number(l.subtotal),
        })),
      };
    };

    let boxedProductId = "";
    const STAMP = { overrideReason: "agreed courtesy price", overriddenBy: "staff-user-b208" };

    async function seedOrder(lines: Record<string, unknown>[]): Promise<string> {
      const o = await raw.order.create({
        data: {
          customerId,
          tenantId,
          status: "PENDING",
          subtotal: "0.00",
          total: "0.00",
          lineItems: { create: lines.map((l) => ({ tenantId, ...l })) as any },
        },
      });
      return o.id;
    }
    const lineOf = async (orderId: string) =>
      raw.orderItem.findMany({ where: { orderId }, orderBy: { position: "asc" } });

    async function wipe() {
      const ids = (await raw.order.findMany({ where: { tenantId }, select: { id: true } })).map(
        (o) => o.id,
      );
      await (raw as any).orderRevision?.deleteMany?.({ where: { orderId: { in: ids } } });
      await raw.stockMovement.deleteMany({
        where: { productId: { in: [productId, boxedProductId].filter(Boolean) } },
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

      tenantId = (await raw.tenant.create({ data: { slug, name: `B208 ${slug}` } })).id;
      buyerUserId = (
        await raw.user.create({
          data: {
            email: `b-${run}@example.test`,
            username: `b-${run}`,
            role: "CUSTOMER",
            tenantId,
          },
        })
      ).id;
      customerId = (
        await raw.customer.create({
          data: { userId: buyerUserId, businessName: `Acme ${run}`, contactName: "T", tenantId },
        })
      ).id;
      productId = (
        await raw.product.create({
          data: {
            name: `Bread ${run}`,
            unit: "Each",
            pricePerUnit: "5.00",
            currentStock: "100000",
            tenantId,
          },
        })
      ).id;
      boxedProductId = (
        await raw.product.create({
          data: {
            name: `Cola ${run}`,
            unit: "Box",
            pricePerUnit: "12.00",
            unitsPerBox: 12,
            currentStock: "100000",
            tenantId,
          },
        })
      ).id;
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

    it("plain line: MANUAL $4 x 10 + buyer adds 2 -> 12 @ $4 = $48, MANUAL, stamp kept (a $60 here is the B208 overcharge)", async () => {
      const orderId = await seedOrder([
        {
          productId,
          qty: 10,
          unitPrice: "4.00",
          subtotal: "40.00",
          priceType: "MANUAL",
          originalPrice: "5.00",
          ...STAMP,
        },
      ]);

      const result = await submit([{ productId, qty: 2 }], {}, `k-${run}-a`);

      expect(result.id).toBe(orderId);
      const lines = await lineOf(orderId);
      expect(
        lines.map((l) => [Number(l.qty), Number(l.unitPrice), Number(l.subtotal), l.priceType]),
      ).toEqual([[12, 4, 48, "MANUAL"]]);
      expect(lines[0].overrideReason).toBe(STAMP.overrideReason);
      expect(lines[0].overriddenBy).toBe(STAMP.overriddenBy);
    }, 120_000);

    it("boxed twin: box-split MANUAL $8 a box + buyer adds one box -> 2 boxes + 6 pieces at $8 = $20, MANUAL, stamp kept", async () => {
      const orderId = await seedOrder([
        {
          productId: boxedProductId,
          qty: 18,
          boxes: 1,
          pieces: 6,
          unitsPerBox: 12,
          unitPrice: "8.00",
          subtotal: "12.00",
          priceType: "MANUAL",
          originalPrice: "12.00",
          ...STAMP,
        },
      ]);

      const result = await submit([{ productId: boxedProductId, qty: 1 }], {}, `k-${run}-b`);

      expect(result.id).toBe(orderId);
      const lines = await lineOf(orderId);
      expect(
        lines.map((l) => [
          Number(l.qty),
          l.boxes,
          l.pieces,
          Number(l.unitPrice),
          Number(l.subtotal),
          l.priceType,
        ]),
      ).toEqual([[30, 2, 6, 8, 20, "MANUAL"]]);
      expect(lines[0].overrideReason).toBe(STAMP.overrideReason);
    }, 120_000);
  },
);
