/**
 * B1234 (owner ruling 2026-10-03, D-O2-a / SA-648, "T3 lock delivered lines"): on a PARTIALLY_DELIVERED
 * order a line that has been delivered (deliveredQty > 0) is LOCKED. No entry point may change its
 * quantity, price or unit, substitute it, strike it off or delete it: 409 ORDER_LINE_DELIVERED_LOCKED,
 * nothing written. The undelivered lines of the same order, a note on a delivered line, a brand-new line,
 * and every OTHER order status behave exactly as before.
 *
 * Drives the real OrdersService.updateOrderItems (the one writer of existing lines on an order); the guard
 * runs twice, once on the pre-tx read and once on the Order-locked read.
 */

jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { oversellReaderOffProvider } from "./testing/policy-reader-provider";
import { Test, TestingModule } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";
import { OrdersService } from "./orders.service";
import { InvoicesService } from "../invoices/invoices.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { createMockPrisma } from "../testing/prisma-mock";
import { NotificationsService } from "../notifications/notifications.service";
import { InventoryService } from "../inventory/inventory.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { PromotionsService } from "../promotions/promotions.service";
import { MessagingService } from "../messaging/messaging.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { UserRole } from "@prisma/client";

const LOCKED = { response: { code: "ORDER_LINE_DELIVERED_LOCKED" }, status: 409 };

const operator = {
  sub: "user-op",
  email: "op@example.com",
  role: UserRole.OPERATOR,
  tenantId: "test-tenant",
} as any;
const driver = { ...operator, sub: "user-drv", role: UserRole.DRIVER } as any;

const line = (over: Record<string, unknown>) => ({
  orderId: "ord-1",
  productId: "prod-1",
  qty: 5,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitPrice: 5,
  subtotal: 25,
  status: "PENDING",
  priceType: "STANDARD",
  originalPrice: null,
  invoicedQty: 0,
  deliveredQty: 0,
  promoFreeUnits: null,
  unitLabel: null,
  notes: null,
  overrideReason: null,
  position: 0,
  ...over,
});
/** li-del: 2 of 5 delivered. li-open: nothing delivered yet. */
const DELIVERED_LINE = line({ id: "li-del", position: 0, deliveredQty: 2 });
const OPEN_LINE = line({ id: "li-open", productId: "prod-2", position: 1 });

const orderWith = (status: string, lineItems: any[]) => ({
  id: "ord-1",
  tenantId: "test-tenant",
  customerId: "cust-1",
  status,
  routeRun: null,
  shippingFee: 0,
  lineItems,
});

describe("B1234: delivered lines of a PARTIALLY_DELIVERED order are locked (updateOrderItems)", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        oversellReaderOffProvider,
        OrdersService,
        {
          provide: TenantContextService,
          useValue: { run: (_tenantId: string | null, fn: () => unknown) => fn() },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: getQueueToken("invoices"), useValue: { add: jest.fn() } },
        {
          provide: RouteFlowGateway,
          useValue: { emitOrderStatusChanged: jest.fn(), emitOrderCreated: jest.fn() },
        },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(0.1) } },
        {
          provide: InvoicesService,
          useValue: {
            findOpenOrderDraft: jest.fn().mockResolvedValue(null),
            reconcileOrderDraftInvoice: jest.fn().mockResolvedValue({ id: "inv-1" }),
            resyncOrderInvoicesForEdit: jest.fn().mockResolvedValue([]),
            followPartialPrices: jest.fn().mockResolvedValue({ issuedPartialsUnchanged: [] }),
            projectEditedInvoiceTotals: jest.fn().mockResolvedValue([]),
            revertLinkedInvoicesForOrderEdit: jest.fn().mockResolvedValue([]),
          },
        },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: NotificationsService, useValue: {} },
        { provide: InventoryService, useValue: {} },
        {
          provide: SellingRestrictionsService,
          useValue: {
            getPolicy: jest.fn().mockResolvedValue({ enabled: false }),
            assertLinesSellable: jest.fn().mockResolvedValue(undefined),
            checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "OFF", reasons: [] }),
          },
        },
        {
          provide: AuthorizationGuardService,
          useValue: { assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: PromotionsService,
          useValue: { activeForCatalog: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: MessagingService,
          useValue: { notifyEvent: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: CreditNotesService,
          useValue: {
            previewOrderCreditRelease: jest.fn().mockResolvedValue([]),
            settleOrderCreditsInTx: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: CommissionEngineService, useValue: {} },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(true) } },
        {
          provide: RegulatedLedgerService,
          useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    service = module.get<OrdersService>(OrdersService);

    prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    prisma.customerPrice.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([
      {
        id: "prod-1",
        name: "Tomatoes",
        pricePerUnit: 5,
        unitsPerBox: null,
        trackedCategoryId: null,
      },
      { id: "prod-2", name: "Onions", pricePerUnit: 5, unitsPerBox: null, trackedCategoryId: null },
    ]);
    prisma.deliveryMutation.count.mockResolvedValue(0);
    prisma.orderItem.updateMany.mockResolvedValue({ count: 1 });
    prisma.orderItem.deleteMany.mockResolvedValue({ count: 1 });
  });

  /** Pre-tx snapshot = `lines`; the post-lock read returns `locked ?? lines`. */
  function seed(status: string, lines: any[], locked?: any[]) {
    prisma.order.findUnique.mockResolvedValue(orderWith(status, lines));
    const rows = locked ?? lines;
    prisma.orderItem.findMany.mockImplementation(async (args: any) =>
      args?.where?.status ? rows.filter((r) => r.status !== "CANCELLED") : rows,
    );
  }

  const nothingWritten = () => {
    expect(prisma.orderItem.update).not.toHaveBeenCalled();
    expect(prisma.orderItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.orderItem.delete).not.toHaveBeenCalled();
    expect(prisma.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(prisma.orderItem.create).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
  };

  describe("(1) a delivered line cannot be edited", () => {
    it("a qty edit is 409 ORDER_LINE_DELIVERED_LOCKED and nothing is written", async () => {
      seed("PARTIALLY_DELIVERED", [DELIVERED_LINE, OPEN_LINE]);
      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ id: "li-del", action: "UPDATE", qty: 3 }] } as any,
          operator,
        ),
      ).rejects.toMatchObject(LOCKED);
      nothingWritten();
    });

    it("a price edit is 409", async () => {
      seed("PARTIALLY_DELIVERED", [DELIVERED_LINE, OPEN_LINE]);
      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ id: "li-del", action: "UPDATE", qty: 5, unitPrice: 4 }] } as any,
          operator,
        ),
      ).rejects.toMatchObject(LOCKED);
      nothingWritten();
    });

    it("a substitution of the line is 409", async () => {
      seed("PARTIALLY_DELIVERED", [DELIVERED_LINE, OPEN_LINE]);
      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ id: "li-del", substituteProductId: "prod-2" }] } as any,
          operator,
        ),
      ).rejects.toMatchObject(LOCKED);
      nothingWritten();
    });
  });

  describe("(2) a delivered line cannot be removed", () => {
    it.each(["DELETE", "CANCEL"])("%s is 409 and nothing is written", async (action) => {
      seed("PARTIALLY_DELIVERED", [DELIVERED_LINE, OPEN_LINE]);
      await expect(
        service.updateOrderItems("ord-1", { items: [{ id: "li-del", action }] } as any, operator),
      ).rejects.toMatchObject(LOCKED);
      nothingWritten();
    });

    it("a driver's per-line CANCEL of a delivered line is 409 too (every role)", async () => {
      seed("PARTIALLY_DELIVERED", [DELIVERED_LINE, OPEN_LINE]);
      // SA-429: the driver owns the order's stop on a run in progress.
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" });
      prisma.order.findFirst.mockResolvedValue({ routeRunStopId: "stop-1" });
      prisma.routeRunStop.findFirst.mockResolvedValue({
        status: "PENDING",
        routeRun: { driverId: "drv-1", status: "IN_PROGRESS" },
      });
      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ id: "li-del", action: "CANCEL" }] } as any,
          driver,
        ),
      ).rejects.toMatchObject(LOCKED);
      nothingWritten();
    });

    it("a replace-all that would delete and re-create a delivered line is 409", async () => {
      seed("PARTIALLY_DELIVERED", [DELIVERED_LINE, OPEN_LINE]);
      await expect(
        service.updateOrderItems(
          "ord-1",
          { replaceAll: true, items: [{ productId: "prod-1", qty: 5 }] } as any,
          operator,
        ),
      ).rejects.toMatchObject(LOCKED);
      nothingWritten();
    });
  });

  describe("(3) the undelivered rest of the same order still edits", () => {
    it("an UNDELIVERED line's qty edit goes through", async () => {
      seed("PARTIALLY_DELIVERED", [DELIVERED_LINE, OPEN_LINE]);
      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-open", action: "UPDATE", qty: 3 }] } as any,
        operator,
      );
      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-open" },
          data: expect.objectContaining({ qty: 3 }),
        }),
      );
    });

    it("an UNDELIVERED line can be deleted", async () => {
      seed("PARTIALLY_DELIVERED", [DELIVERED_LINE, OPEN_LINE]);
      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-open", action: "DELETE" }] } as any,
        operator,
      );
      expect(prisma.orderItem.deleteMany).toHaveBeenCalledWith({
        where: { id: "li-open", orderId: "ord-1" },
      });
    });

    it("a note on the delivered line (qty sent unchanged, the web page's shape) is not a lock hit", async () => {
      seed("PARTIALLY_DELIVERED", [DELIVERED_LINE, OPEN_LINE]);
      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-del", action: "UPDATE", qty: 5, notes: "left at dock" }] } as any,
        operator,
      );
      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-del" },
          data: expect.objectContaining({ notes: "left at dock" }),
        }),
      );
    });

    it("a brand-new line can still be added", async () => {
      seed("PARTIALLY_DELIVERED", [DELIVERED_LINE, OPEN_LINE]);
      prisma.orderItem.create.mockResolvedValue({ id: "li-new" });
      await service.updateOrderItems(
        "ord-1",
        { items: [{ name: "Ad hoc", qty: 1, unitPrice: 3 }] } as any,
        operator,
      );
      expect(prisma.orderItem.create).toHaveBeenCalled();
    });
  });

  describe("(4) other statuses behave exactly as before", () => {
    it.each(["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY", "DELIVERED"])(
      "%s: a qty edit of a line with deliveredQty > 0 is NOT refused by the lock",
      async (status) => {
        seed(status, [DELIVERED_LINE, OPEN_LINE]);
        await service.updateOrderItems(
          "ord-1",
          { items: [{ id: "li-del", action: "UPDATE", qty: 3 }] } as any,
          operator,
        );
        expect(prisma.orderItem.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: "li-del" },
            data: expect.objectContaining({ qty: 3 }),
          }),
        );
      },
    );
  });

  describe("(5) the lock is judged on the Order-locked read, not only the snapshot", () => {
    it("a line another writer delivered while this edit waited on the lock is refused, nothing written", async () => {
      // Snapshot: nothing delivered. Locked read: li-open now has deliveredQty 2.
      seed(
        "PARTIALLY_DELIVERED",
        [DELIVERED_LINE, OPEN_LINE],
        [DELIVERED_LINE, { ...OPEN_LINE, deliveredQty: 2 }],
      );
      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ id: "li-open", action: "UPDATE", qty: 3 }] } as any,
          operator,
        ),
      ).rejects.toMatchObject(LOCKED);
      nothingWritten();
    });
  });
});
