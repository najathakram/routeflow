/**
 * W-861 (SA-944 §3) + W-871 (SA-948 §2 MUST 1/3): two refusals in updateOrderItems, both before any write.
 *  - A paid walk-in sale is locked: the shared Walk-in customer cannot be collected from, so an edit that adds to
 *    (or otherwise changes) a walk-in order with a live payment on its invoice is 409 WALK_IN_SALE_PAID.
 *  - A replace (staff replace-all, a driver's full-list save) on a post-delivery order deletes and re-creates every
 *    line, so the invoice's lines lose their provenance and the re-sync cannot restate them: 409
 *    LINES_REPLACE_AFTER_DELIVERY. Per-line edits of a named customer's paid sale keep R1.
 *  - Order: the walk-in refusal wins over the replace refusal.
 * On master both edits are accepted (the walk-in owes the added line; the replace leaves the invoice PAID at its
 * old total).
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

const WALK_IN_PAID = { response: { code: "WALK_IN_SALE_PAID" }, status: 409 };
const REPLACE_LOCKED = { response: { code: "LINES_REPLACE_AFTER_DELIVERY" }, status: 409 };

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
  qty: 1,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitPrice: 2,
  subtotal: 2,
  status: "PENDING",
  priceType: "STANDARD",
  originalPrice: null,
  invoicedQty: 1,
  deliveredQty: 1,
  promoFreeUnits: null,
  unitLabel: null,
  notes: null,
  overrideReason: null,
  position: 0,
  ...over,
});
const SOLD = line({ id: "li-1" });

const orderWith = (status: string, isWalkIn: boolean) => ({
  id: "ord-1",
  tenantId: "test-tenant",
  customerId: "cust-1",
  customer: { isWalkIn },
  status,
  routeRun: null,
  shippingFee: 0,
  lineItems: [SOLD],
});

describe("W-861 + W-871: a paid walk-in sale and a post-delivery replace are refused (updateOrderItems)", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let invoices: Record<string, jest.Mock>;
  let promotions: Record<string, jest.Mock>;

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
          useValue: {
            reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined),
            settleRegulatedLedger: jest.fn().mockResolvedValue({ written: 0, amendedPeriod: null }),
          },
        },
      ],
    }).compile();
    service = module.get<OrdersService>(OrdersService);
    invoices = module.get(InvoicesService) as any;
    promotions = module.get(PromotionsService) as any;

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

  const nothingWritten = () => {
    expect(prisma.orderItem.update).not.toHaveBeenCalled();
    expect(prisma.orderItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.orderItem.delete).not.toHaveBeenCalled();
    expect(prisma.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(prisma.orderItem.create).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
    // stock: no product-stock write and no movement
    expect(prisma.product.update).not.toHaveBeenCalled();
    expect(prisma.product.updateMany).not.toHaveBeenCalled();
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    expect(prisma.stockMovement.createMany).not.toHaveBeenCalled();
  };
  /** A refusal that fired BEFORE the transaction: the invoices were never touched either. */
  const invoicesUntouched = () => {
    expect(invoices.revertLinkedInvoicesForOrderEdit).not.toHaveBeenCalled();
    expect(invoices.resyncOrderInvoicesForEdit).not.toHaveBeenCalled();
    expect(invoices.reconcileOrderDraftInvoice).not.toHaveBeenCalled();
  };

  function seed(status: string, isWalkIn: boolean, paid: boolean) {
    prisma.order.findUnique.mockResolvedValue(orderWith(status, isWalkIn));
    prisma.orderItem.findMany.mockResolvedValue([SOLD]);
    prisma.invoicePayment.findFirst.mockResolvedValue(paid ? { id: "pay-1" } : null);
  }
  const addLine = { items: [{ productId: "prod-2", action: "ADD", qty: 1 }] } as any;
  const replaceAll = { replaceAll: true, items: [{ productId: "prod-2", qty: 1 }] } as any;

  describe("W-861: a paid walk-in sale", () => {
    it("adding a line is 409 WALK_IN_SALE_PAID and nothing is written (master: 200, 2.16 owed by Walk-in)", async () => {
      seed("DELIVERED", true, true);
      await expect(service.updateOrderItems("ord-1", addLine, operator)).rejects.toMatchObject(
        WALK_IN_PAID,
      );
      nothingWritten();
      invoicesUntouched();
    });

    it("the refusal names what to do instead", async () => {
      seed("DELIVERED", true, true);
      const err: any = await service.updateOrderItems("ord-1", addLine, operator).catch((e) => e);
      expect(err.response.message).toBe(
        "This sale is paid. Ring up added items as a new sale, or use Return to take items back.",
      );
    });

    it("the walk-in refusal wins over the replace refusal", async () => {
      seed("DELIVERED", true, true);
      await expect(service.updateOrderItems("ord-1", replaceAll, operator)).rejects.toMatchObject(
        WALK_IN_PAID,
      );
    });

    it("the payment read counts only live payments on live invoices of THIS order", async () => {
      seed("DELIVERED", true, true);
      await service.updateOrderItems("ord-1", addLine, operator).catch(() => undefined);
      const where = prisma.invoicePayment.findFirst.mock.calls[0][0].where;
      expect(where.status).toEqual({ in: ["DRAFT", "PAID", "PENDING"] });
      expect(where.invoice).toEqual({ orderId: "ord-1", status: { not: "VOID" } });
    });

    it("an unpaid walk-in pickup is not refused by the walk-in rule", async () => {
      seed("CONFIRMED", true, false);
      const err = await service.updateOrderItems("ord-1", addLine, operator).catch((e) => e);
      expect(err?.response?.code).not.toBe("WALK_IN_SALE_PAID");
    });

    it("a named customer is never read for payments (no walk-in, no extra read)", async () => {
      seed("DELIVERED", false, true);
      await service.updateOrderItems("ord-1", addLine, operator).catch(() => undefined);
      expect(prisma.invoicePayment.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("W-871: a replace on a post-delivery order", () => {
    it.each(["OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED", "DELIVERED"])(
      "a staff replace-all on a %s paid named sale is 409 LINES_REPLACE_AFTER_DELIVERY, nothing written",
      async (status) => {
        // PARTIALLY_DELIVERED with no delivered line, so the B1234 guard does not answer first.
        prisma.order.findUnique.mockResolvedValue({
          ...orderWith(status, false),
          lineItems: [{ ...SOLD, deliveredQty: 0 }],
        });
        prisma.orderItem.findMany.mockResolvedValue([{ ...SOLD, deliveredQty: 0 }]);
        await expect(service.updateOrderItems("ord-1", replaceAll, operator)).rejects.toMatchObject(
          REPLACE_LOCKED,
        );
        nothingWritten();
        invoicesUntouched();
      },
    );

    it("the refusal copy", async () => {
      seed("DELIVERED", false, true);
      const err: any = await service
        .updateOrderItems("ord-1", replaceAll, operator)
        .catch((e) => e);
      expect(err.response.message).toBe(
        "This order has been delivered. Change its lines one at a time.",
      );
    });

    it("a driver's full-list save on an OUT_FOR_DELIVERY order is 409 too", async () => {
      seed("OUT_FOR_DELIVERY", false, true);
      // SA-429: the driver owns the order's stop on a run in progress.
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" });
      prisma.order.findFirst.mockResolvedValue({ routeRunStopId: "stop-1" });
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        status: "PENDING",
        routeRun: { driverId: "drv-1", status: "IN_PROGRESS" },
      });
      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ productId: "prod-1", qty: 1 }] } as any,
          driver,
        ),
      ).rejects.toMatchObject(REPLACE_LOCKED);
      nothingWritten();
    });

    it("a staff replace-all on a CONFIRMED (pre-delivery) order is not refused by this rule", async () => {
      seed("CONFIRMED", false, false);
      const err = await service.updateOrderItems("ord-1", replaceAll, operator).catch((e) => e);
      expect(err?.response?.code).not.toBe("LINES_REPLACE_AFTER_DELIVERY");
    });

    it("a per-line add on a DELIVERED named sale is not refused by either rule (R1 kept)", async () => {
      seed("DELIVERED", false, true);
      const err = await service.updateOrderItems("ord-1", addLine, operator).catch((e) => e);
      expect(["LINES_REPLACE_AFTER_DELIVERY", "WALK_IN_SALE_PAID"]).not.toContain(
        err?.response?.code,
      );
    });
  });
});
