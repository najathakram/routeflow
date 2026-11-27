/**
 * SA-1506 PR-1a (SA-1536 (ah)): an at-door change request that names a line which already holds delivered goods is answered
 * with the bare delivered code (`orders.service.ts` `approveChangeRequestAtStop`), never a lock reason or sentence of the
 * correction (PR-1a changes nothing on the at-stop path), and nothing is written: the request stays PENDING, the line and the
 * stock stay as they were. Harness of a2-at-stop-change-qty-stored-pack.db.spec.ts, real Postgres, test tenant only.
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
import { OrdersService } from "./orders.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { INVOICE_EDIT_STUBS } from "./testing/invoice-edit-stubs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("SA-1536 (ah): an at-door change request on a delivered line, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(
    `qa-sa1506h-${run}`,
    "delivered-line-correction.at-stop.db.spec.ts",
  );
  let tenantId = "";
  let driverUserId = "";
  let driverId = "";
  let customerId = "";
  let n = 0;

  const driver = (): JwtPayload =>
    ({
      sub: driverUserId,
      username: `dr-${run}`,
      role: "DRIVER",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    }) as JwtPayload;

  /** An open order, one line of 10 of which `delivered` are out, on an IN_PROGRESS run (the stop still open). */
  async function seed(delivered: number) {
    n += 1;
    const product = await raw.product.create({
      data: {
        tenantId,
        name: `Acme cola ${run}-${n}`,
        unit: "each",
        pricePerUnit: 1,
        currentStock: 90,
      } as any,
    });
    const order = await raw.order.create({
      data: {
        tenantId,
        customerId,
        status: "CONFIRMED",
        orderNumber: `ORD-SA1506H-${run}-${n}`,
        subtotal: 10,
        tax: 0,
        total: 10,
      } as any,
    });
    const line = await raw.orderItem.create({
      data: {
        tenantId,
        orderId: order.id,
        productId: product.id,
        qty: 10,
        deliveredQty: delivered,
        unitPrice: 1,
        subtotal: 10,
      } as any,
    });
    const route = await raw.route.create({ data: { name: `r-${run}-${n}`, tenantId } as any });
    const routeStop = await raw.routeStop.create({
      data: { tenantId, routeId: route.id, stopNumber: 1, customerId } as any,
    });
    const rr = await raw.routeRun.create({
      data: {
        tenantId,
        routeId: route.id,
        scheduledDate: new Date("2026-11-20T00:00:00.000Z"),
        status: "IN_PROGRESS" as any,
        driverId,
      },
    });
    const stop = await raw.routeRunStop.create({
      data: {
        tenantId,
        routeRunId: rr.id,
        routeStopId: routeStop.id,
        stopNumber: 1,
        status: "PENDING" as any,
      } as any,
    });
    await raw.order.update({
      where: { id: order.id },
      data: { routeRunId: rr.id, routeRunStopId: stop.id },
    });
    return { orderId: order.id, lineId: line.id, productId: product.id, stopId: stop.id };
  }
  type Seeded = Awaited<ReturnType<typeof seed>>;

  const file = (s: Seeded, type: "CHANGE_QTY" | "REMOVE_ITEM") =>
    raw.changeRequest.create({
      data: {
        tenantId,
        orderId: s.orderId,
        productId: s.productId,
        orderItemId: s.lineId,
        routeRunStopId: s.stopId,
        type: type as any,
        requestedByRole: "DRIVER",
        payload:
          type === "CHANGE_QTY" ? { orderItemId: s.lineId, newQty: 8 } : { orderItemId: s.lineId },
      } as any,
    });

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
        releaseWalletPaymentsInTx: async () => undefined,
        voidInvoiceInTx: async () => undefined,
      },
      creditNotes: {
        settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }),
        previewOrderCreditRelease: async () => [],
        releaseOrderCreditsInTx: async () => undefined,
      },
      logger: new Logger(OrdersService.name),
      inlineReturns: {},
      oversellReader: { read: async () => false },
    });
    tenantId = (await raw.tenant.create({ data: { slug, name: `SA1506H ${slug}` } })).id;
    const buyer = await raw.user.create({
      data: {
        email: `buyer-${run}@example.test`,
        username: `buyer-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    customerId = (
      await raw.customer.create({
        data: { userId: buyer.id, businessName: "Acme Retail", contactName: "Tester", tenantId },
      })
    ).id;
    driverUserId = (
      await raw.user.create({
        data: { email: `dr-${run}@example.test`, username: `dr-${run}`, role: "DRIVER", tenantId },
      })
    ).id;
    driverId = (await raw.driver.create({ data: { userId: driverUserId, tenantId } as any })).id;
  }, 120_000);

  afterAll(async () => {
    try {
      await raw.changeRequest.deleteMany({ where: { tenantId } });
      await raw.deliveryMutation.deleteMany({ where: { tenantId } });
      const ids = (await raw.order.findMany({ where: { tenantId }, select: { id: true } })).map(
        (o) => o.id,
      );
      await (raw as any).orderRevision?.deleteMany?.({ where: { orderId: { in: ids } } });
      await raw.stockMovement.deleteMany({ where: { product: { tenantId } } });
      await raw.orderItem.deleteMany({ where: { tenantId } });
      await raw.order.deleteMany({ where: { tenantId } });
      await raw.routeRunStop.deleteMany({ where: { routeRun: { route: { tenantId } } } });
      await raw.routeRun.deleteMany({ where: { route: { tenantId } } });
      await raw.routeStop.deleteMany({ where: { route: { tenantId } } });
      await raw.route.deleteMany({ where: { tenantId } });
      await raw.auditLog.deleteMany({ where: { tenantId } });
      await raw.driver.deleteMany({ where: { tenantId } });
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

  it("(ah) approving a CHANGE_QTY or REMOVE_ITEM on a line that holds delivered goods answers the bare LINE_ALREADY_DELIVERED, never a lock reason, and writes nothing", async () => {
    for (const type of ["CHANGE_QTY", "REMOVE_ITEM"] as const) {
      const s = await seed(4);
      const cr = await file(s, type);
      let thrown: any;
      await tenantCtx
        .run(tenantId, () => orders.approveChangeRequestAtStop(cr.id, driver()))
        .catch((e: any) => {
          thrown = e;
        });
      expect(thrown?.getStatus?.()).toBe(409);
      // the BARE code: no message, no reason, no lock sentence (wrong value: a correction reason such as ROUTE)
      expect(thrown.getResponse()).toEqual({ code: "LINE_ALREADY_DELIVERED" });
      const line = await raw.orderItem.findUniqueOrThrow({ where: { id: s.lineId } });
      expect([type, Number(line.qty), Number(line.deliveredQty), line.status]).toEqual([
        type,
        10,
        4,
        "PENDING",
      ]);
      expect((await raw.changeRequest.findUniqueOrThrow({ where: { id: cr.id } })).status).toBe(
        "PENDING",
      );
      expect(
        Number((await raw.product.findUniqueOrThrow({ where: { id: s.productId } })).currentStock),
      ).toBe(90);
    }
  }, 120_000);
});
