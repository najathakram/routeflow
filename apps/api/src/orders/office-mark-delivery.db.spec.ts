/**
 * SA-151 (B692, #938 5814561170) — DB lane: a manual `changeStatus` to DELIVERED/
 * PARTIALLY_DELIVERED must create the SAME delivery evidence a route stop's own completion does
 * (`office-mark-delivery.ts`), so `deliveredQty` — and everything downstream that trusts it
 * (order-cancel-impact.ts's B56 gate, order-stock.ts's credit clamp) — is never silently 0 for an
 * order delivered from the office. Real Postgres: the bug is in what a REAL Prisma read of the
 * order's evidence rows returns compared with a REAL read of `deliveredQty` afterward — a mocked
 * Prisma can't prove the write-then-recompute-then-read sequence actually round-trips.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * `requireLocalDatabaseUrl()` refuses any non-local host. Every tenant is a throwaway
 * `qa-b692-<run>-<n>` slug (`assertTestTenant`); `afterAll` deletes exactly what this run created.
 */

jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { Test, TestingModule } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bull";
import { randomUUID } from "crypto";
import { OrdersService } from "./orders.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NotificationsService } from "../notifications/notifications.service";
import { InvoicesService } from "../invoices/invoices.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { InventoryService } from "../inventory/inventory.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { PromotionsService } from "../promotions/promotions.service";
import { MessagingService } from "../messaging/messaging.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-b692-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "office-mark-delivery.db.spec.ts",
  );
}

const OPERATOR = {
  sub: "op",
  username: "operator",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

describeDb(
  "B692/SA-151 — a manual changeStatus DELIVERED/PARTIALLY_DELIVERED writes real delivery evidence",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let ordersService: OrdersService;
    const createdTenantIds: string[] = [];

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          OrdersService,
          { provide: PrismaService, useValue: prisma },
          { provide: getQueueToken("invoices"), useValue: { add: jest.fn() } },
          {
            provide: RouteFlowGateway,
            useValue: {
              emitStopCompleted: jest.fn(),
              emitOrderCreated: jest.fn(),
              emitUrgentOrder: jest.fn(),
              emitOrderStatusChanged: jest.fn(),
              emitLowStock: jest.fn(),
            },
          },
          {
            provide: InvoicesService,
            useValue: {
              findOpenOrderDraft: jest.fn().mockResolvedValue(null),
              reconcileOrderDraftInvoice: jest.fn().mockResolvedValue({ id: "inv-1" }),
              createInvoiceFromOrderWithTenant: jest.fn().mockResolvedValue({ id: "inv-1" }),
            },
          },
          { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
          { provide: NotificationsService, useValue: {} },
          { provide: InventoryService, useValue: { recordSale: jest.fn() } },
          {
            provide: AuthorizationGuardService,
            useValue: {
              assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
              checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
            },
          },
          {
            provide: SellingRestrictionsService,
            useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
          },
          { provide: PromotionsService, useValue: {} },
          {
            provide: MessagingService,
            useValue: {
              notify: jest.fn().mockResolvedValue([]),
              notifyEvent: jest.fn().mockResolvedValue(undefined),
            },
          },
          {
            provide: CreditNotesService,
            useValue: {
              settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
              releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
            },
          },
          {
            provide: CommissionEngineService,
            useValue: {
              syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
              syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            },
          },
          {
            provide: EntitlementsService,
            useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
          },
          {
            provide: RegulatedLedgerService,
            useValue: { writeSaleEntries: jest.fn(), reverseInvoiceEntries: jest.fn() },
          },
          { provide: TenantContextService, useValue: tenantCtx },
        ],
      }).compile();

      ordersService = module.get(OrdersService);
    });

    afterAll(async () => {
      for (const tenantId of createdTenantIds) {
        // eslint-disable-next-line no-await-in-loop
        await cleanupTenant(tenantId).catch(() => {});
      }
      await prisma?.$disconnect();
    });

    async function cleanupTenant(tenantId: string): Promise<void> {
      await prisma.deliveryMutation.deleteMany({ where: { tenantId } });
      await prisma.orderItem.deleteMany({ where: { tenantId } });
      await prisma.order.deleteMany({ where: { tenantId } });
      await prisma.product.deleteMany({ where: { tenantId } });
      await prisma.customer.deleteMany({ where: { tenantId } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
    }

    async function seedOrder(label: string, lineQtys: number[]) {
      const slug = freshTenantSlug(label);
      const tenant = await prisma.tenant.create({ data: { slug, name: `B692 ${slug}` } });
      createdTenantIds.push(tenant.id);
      const user = await prisma.user.create({
        data: {
          email: `${slug}@example.invalid`,
          username: slug,
          role: "CUSTOMER",
          tenantId: tenant.id,
        },
      });
      const customer = await prisma.customer.create({
        data: {
          userId: user.id,
          businessName: `B692 ${slug}`,
          contactName: `B692 ${slug}`,
          tenantId: tenant.id,
        },
      });
      const order = await prisma.order.create({
        data: {
          tenantId: tenant.id,
          customerId: customer.id,
          orderNumber: `ORD-B692-${slug}`,
          status: "CONFIRMED",
          subtotal: 100,
          tax: 0,
          total: 100,
          source: "APP",
        },
      });
      const products: string[] = [];
      const items: string[] = [];
      for (let i = 0; i < lineQtys.length; i++) {
        const product = await prisma.product.create({
          data: {
            name: `P${i} ${slug}`,
            unit: "ea",
            pricePerUnit: 10,
            currentStock: 100,
            tenantId: tenant.id,
          },
        });
        products.push(product.id);
        const item = await prisma.orderItem.create({
          data: {
            tenantId: tenant.id,
            orderId: order.id,
            productId: product.id,
            description: `P${i}`,
            qty: lineQtys[i],
            unitPrice: 10,
            subtotal: lineQtys[i]! * 10,
            status: "PENDING",
          },
        });
        items.push(item.id);
      }
      return { tenant, order, products, items };
    }

    it("office DELIVERED on 2 lines writes a DeliveryMutation for the FULL qty each and recomputes deliveredQty = qty", async () => {
      const { tenant, order, items } = await seedOrder("a", [10, 5]);

      const updated = await tenantCtx.run(tenant.id, () =>
        ordersService.changeStatus(order.id, { status: "DELIVERED" } as any, OPERATOR as any),
      );
      expect(updated.status).toBe("DELIVERED");

      const rows = await prisma.deliveryMutation.findMany({ where: { orderId: order.id } });
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.routeRunStopId === null && r.driverId === null)).toBe(true);
      expect(rows.every((r) => r.note === "OFFICE_MARKED")).toBe(true);
      expect(new Set(rows.map((r) => Number(r.quantityDelivered)))).toEqual(new Set([10, 5]));

      const refreshedItems = await prisma.orderItem.findMany({ where: { id: { in: items } } });
      expect(refreshedItems.map((i) => Number(i.deliveredQty))).toEqual(
        expect.arrayContaining([10, 5]),
      );
    });

    it("a line already half-delivered on a run gets evidence for only the REMAINDER, ending at deliveredQty = qty", async () => {
      const { tenant, order, items } = await seedOrder("b", [10]);
      // Simulate a run stop's own partial delivery BEFORE the office mark (6 of 10).
      await prisma.deliveryMutation.create({
        data: {
          tenantId: tenant.id,
          orderId: order.id,
          orderItemId: items[0],
          type: "DELIVERED",
          quantityDelivered: 6,
          routeRunStopId: null, // a real run would set this; irrelevant to the office-mark's math
          note: "RUN_STOP",
        },
      });

      await tenantCtx.run(tenant.id, () =>
        ordersService.changeStatus(order.id, { status: "DELIVERED" } as any, OPERATOR as any),
      );

      const rows = await prisma.deliveryMutation.findMany({
        where: { orderId: order.id },
        orderBy: { createdAt: "asc" },
      });
      expect(rows).toHaveLength(2);
      expect(Number(rows[0]!.quantityDelivered)).toBe(6); // untouched prior evidence
      expect(Number(rows[1]!.quantityDelivered)).toBe(4); // exactly the remainder, not the full 10
      expect(rows[1]!.note).toBe("OFFICE_MARKED");

      const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: items[0] } });
      expect(Number(item.deliveredQty)).toBe(10); // recomputed from BOTH rows, never double-counted
    });

    it("a bare PARTIALLY_DELIVERED with no evidence on the order is refused (409 DELIVERY_QUANTITIES_REQUIRED), order untouched", async () => {
      const { tenant, order } = await seedOrder("c", [10]);
      await prisma.order.update({ where: { id: order.id }, data: { status: "OUT_FOR_DELIVERY" } });

      await expect(
        tenantCtx.run(tenant.id, () =>
          ordersService.changeStatus(
            order.id,
            { status: "PARTIALLY_DELIVERED" } as any,
            OPERATOR as any,
          ),
        ),
      ).rejects.toMatchObject({ response: { code: "DELIVERY_QUANTITIES_REQUIRED" } });

      const reread = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(reread.status).toBe("OUT_FOR_DELIVERY"); // the refusal left the order exactly as it was
      expect(await prisma.deliveryMutation.count({ where: { orderId: order.id } })).toBe(0);
    });

    it("PARTIALLY_DELIVERED WITH deliveries[] writes evidence for exactly those quantities and recomputes", async () => {
      const { tenant, order, items } = await seedOrder("d", [10, 5]);
      await prisma.order.update({ where: { id: order.id }, data: { status: "OUT_FOR_DELIVERY" } });

      const updated = await tenantCtx.run(tenant.id, () =>
        ordersService.changeStatus(
          order.id,
          {
            status: "PARTIALLY_DELIVERED",
            deliveries: [{ orderItemId: items[0], type: "PARTIAL", quantityDelivered: 6 }],
          } as any,
          OPERATOR as any,
        ),
      );
      expect(updated.status).toBe("PARTIALLY_DELIVERED");

      const rows = await prisma.deliveryMutation.findMany({ where: { orderId: order.id } });
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.quantityDelivered)).toBe(6);

      const [lineA, lineB] = await prisma.orderItem.findMany({
        where: { id: { in: items } },
        orderBy: { createdAt: "asc" },
      });
      expect(Number(lineA!.deliveredQty)).toBe(6);
      expect(Number(lineB!.deliveredQty)).toBe(0); // untouched — never re-claimed as delivered
    });

    it("a deliveries[] quantity above what remains is refused (400), never written", async () => {
      const { tenant, order, items } = await seedOrder("e", [10]);
      await prisma.order.update({ where: { id: order.id }, data: { status: "OUT_FOR_DELIVERY" } });

      await expect(
        tenantCtx.run(tenant.id, () =>
          ordersService.changeStatus(
            order.id,
            {
              status: "PARTIALLY_DELIVERED",
              deliveries: [{ orderItemId: items[0], type: "PARTIAL", quantityDelivered: 999 }],
            } as any,
            OPERATOR as any,
          ),
        ),
      ).rejects.toThrow();
      expect(await prisma.deliveryMutation.count({ where: { orderId: order.id } })).toBe(0);
    });

    it("an order already carrying evidence flips to PARTIALLY_DELIVERED with no deliveries[] and writes nothing new", async () => {
      const { tenant, order } = await seedOrder("f", [10]);
      await tenantCtx.run(tenant.id, () =>
        ordersService.changeStatus(order.id, { status: "DELIVERED" } as any, OPERATOR as any),
      );
      const beforeCount = await prisma.deliveryMutation.count({ where: { orderId: order.id } });

      const updated = await tenantCtx.run(tenant.id, () =>
        ordersService.changeStatus(
          order.id,
          { status: "PARTIALLY_DELIVERED", reason: "wasn't fully delivered after all" } as any,
          OPERATOR as any,
        ),
      );
      expect(updated.status).toBe("PARTIALLY_DELIVERED");
      expect(await prisma.deliveryMutation.count({ where: { orderId: order.id } })).toBe(
        beforeCount,
      );
    });

    it("an office-mark then a cancel credits ZERO stock back for the delivered line (B56 chain closes end to end)", async () => {
      const { tenant, order, products } = await seedOrder("g", [10]);
      const stockBefore = (await prisma.product.findUniqueOrThrow({ where: { id: products[0] } }))
        .currentStock;

      await tenantCtx.run(tenant.id, () =>
        ordersService.changeStatus(order.id, { status: "DELIVERED" } as any, OPERATOR as any),
      );
      await tenantCtx.run(tenant.id, () =>
        ordersService.changeStatus(
          order.id,
          { status: "CONFIRMED", reason: "reopen" } as any,
          OPERATOR as any,
        ),
      );
      await tenantCtx.run(tenant.id, () =>
        ordersService.changeStatus(
          order.id,
          { status: "CANCELLED", reason: "customer changed their mind" } as any,
          OPERATOR as any,
        ),
      );

      const stockAfter = (await prisma.product.findUniqueOrThrow({ where: { id: products[0] } }))
        .currentStock;
      // Pre-fix (deliveredQty silently 0): the cancel would have credited the full 10 back.
      expect(Number(stockAfter)).toBe(Number(stockBefore)); // unchanged — the delivered qty was clamped to 0 credit
    });
  },
);
