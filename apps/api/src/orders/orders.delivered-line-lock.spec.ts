/**
 * B1234 (owner ruling 2026-10-03, D-O2-a / SA-648, "T3 lock delivered lines"): on a PARTIALLY_DELIVERED
 * order a line that has been delivered (deliveredQty > 0) is LOCKED. No entry point may change its
 * quantity, price or unit, substitute it, strike it off or delete it: 409 LINE_ALREADY_DELIVERED,
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
import { BadRequestException, ConflictException } from "@nestjs/common";

const LOCKED = { response: { code: "LINE_ALREADY_DELIVERED" }, status: 409 };

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
          useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
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

  describe("(1) a delivered line cannot be edited", () => {
    it("a qty edit is 409 LINE_ALREADY_DELIVERED and nothing is written", async () => {
      seed("PARTIALLY_DELIVERED", [DELIVERED_LINE, OPEN_LINE]);
      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ id: "li-del", action: "UPDATE", qty: 3 }] } as any,
          operator,
        ),
      ).rejects.toMatchObject(LOCKED);
      nothingWritten();
      invoicesUntouched();
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
      invoicesUntouched();
    });

    it("a unit change (unitLabel) on the delivered line is 409", async () => {
      seed("PARTIALLY_DELIVERED", [DELIVERED_LINE, OPEN_LINE]);
      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ id: "li-del", action: "UPDATE", qty: 5, unitLabel: "Case" }] } as any,
          operator,
        ),
      ).rejects.toMatchObject(LOCKED);
      nothingWritten();
      invoicesUntouched();
    });

    it("a qty cut from 3-delivered-of-5 (the stated case): 5 to 2 is 409", async () => {
      seed("PARTIALLY_DELIVERED", [{ ...DELIVERED_LINE, deliveredQty: 3 }, OPEN_LINE]);
      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ id: "li-del", action: "UPDATE", qty: 2 }] } as any,
          operator,
        ),
      ).rejects.toMatchObject(LOCKED);
      nothingWritten();
      invoicesUntouched();
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
      invoicesUntouched();
    });
  });

  describe("(2) a delivered line cannot be removed", () => {
    it.each(["DELETE", "CANCEL"])("%s is 409 and nothing is written", async (action) => {
      seed("PARTIALLY_DELIVERED", [DELIVERED_LINE, OPEN_LINE]);
      await expect(
        service.updateOrderItems("ord-1", { items: [{ id: "li-del", action }] } as any, operator),
      ).rejects.toMatchObject(LOCKED);
      nothingWritten();
      invoicesUntouched();
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
      invoicesUntouched();
    });

    it.each([
      ["re-creating the delivered line", [{ productId: "prod-1", qty: 5 }]],
      ["omitting the delivered line", [{ productId: "prod-2", qty: 5 }]],
      ["with an empty list", []],
    ])("a replace-all %s is 409 (replace modes fail closed)", async (_n, items) => {
      seed("PARTIALLY_DELIVERED", [DELIVERED_LINE, OPEN_LINE]);
      await expect(
        service.updateOrderItems("ord-1", { replaceAll: true, items } as any, operator),
      ).rejects.toMatchObject(LOCKED);
      nothingWritten();
      invoicesUntouched();
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

    it("a note-only change on the delivered line (no qty at all) is allowed", async () => {
      seed("PARTIALLY_DELIVERED", [DELIVERED_LINE, OPEN_LINE]);
      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-del", action: "UPDATE", notes: "gate code 4412" }] } as any,
        operator,
      );
      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-del" },
          data: expect.objectContaining({ notes: "gate code 4412" }),
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
    // Snapshot: li-open undelivered. Locked read: delivered 3 of 5. The pre-tx call passes; only the in-tx call can refuse.
    it.each([
      ["a qty cut", { id: "li-open", action: "UPDATE", qty: 2 }],
      ["a DELETE", { id: "li-open", action: "DELETE" }],
      ["a CANCEL", { id: "li-open", action: "CANCEL" }],
      ["a substitution", { id: "li-open", substituteProductId: "prod-1" }],
      ["a unit change", { id: "li-open", action: "UPDATE", qty: 5, unitLabel: "Case" }],
    ])(
      "stale snapshot, locked row delivered: %s is refused on the locked read",
      async (_n, entry) => {
        seed(
          "PARTIALLY_DELIVERED",
          [DELIVERED_LINE, OPEN_LINE],
          [DELIVERED_LINE, { ...OPEN_LINE, deliveredQty: 3 }],
        );
        await expect(
          service.updateOrderItems("ord-1", { items: [entry] } as any, operator),
        ).rejects.toMatchObject(LOCKED);
        nothingWritten();
      },
    );

    it("the order flipped into PARTIALLY_DELIVERED between the pre-tx read and the lock: the locked status decides, the cut is refused, nothing written", async () => {
      const a = line({ id: "li-a", position: 0, qty: 5 });
      // Pre-tx read: CONFIRMED, A undelivered (neither guard can fire on it). Locked read: the driver delivered 3 of A
      // and the order is PARTIALLY_DELIVERED.
      seed("CONFIRMED", [a, OPEN_LINE], [{ ...a, deliveredQty: 3 }, OPEN_LINE]);
      prisma.order.findUnique
        .mockResolvedValueOnce(orderWith("CONFIRMED", [a, OPEN_LINE]))
        .mockResolvedValue({
          ...orderWith("PARTIALLY_DELIVERED", [{ ...a, deliveredQty: 3 }, OPEN_LINE]),
        });
      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ id: "li-a", action: "UPDATE", qty: 2 }] } as any,
          operator,
        ),
      ).rejects.toMatchObject(LOCKED);
      nothingWritten();
    });

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

  describe("(5b) row 586: a refused edit never commits the SENT -> DRAFT revert", () => {
    /**
     * `revertLinkedInvoicesForOrderEdit` called WITHOUT a transaction and without `preflightOnly` writes on its own
     * connection: it commits at once and nothing the edit throws afterwards can undo it. Called with the edit's
     * `tx` it rolls back with the refusal.
     */
    const ownConnectionWrites = () =>
      invoices.revertLinkedInvoicesForOrderEdit.mock.calls.filter(
        ([, tx, opts]: any[]) => !tx && !opts?.preflightOnly,
      );

    it("the order flipped to PARTIALLY_DELIVERED between the pre-tx read and the lock: the binding 409 leaves the SENT invoice SENT", async () => {
      const a = line({ id: "li-a", position: 0, qty: 5 });
      seed("CONFIRMED", [a, OPEN_LINE], [{ ...a, deliveredQty: 3 }, OPEN_LINE]);
      prisma.order.findUnique
        .mockResolvedValueOnce(orderWith("CONFIRMED", [a, OPEN_LINE]))
        .mockResolvedValue({
          ...orderWith("PARTIALLY_DELIVERED", [{ ...a, deliveredQty: 3 }, OPEN_LINE]),
        });
      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ id: "li-a", action: "UPDATE", qty: 2 }] } as any,
          operator,
        ),
      ).rejects.toMatchObject(LOCKED);
      expect(ownConnectionWrites()).toHaveLength(0); // master: 1 (the pre-tx revert, committed)
      // SA-833: refuse first, write after - the in-tx revert never ran either
      expect(
        invoices.revertLinkedInvoicesForOrderEdit.mock.calls.filter(([, tx]: any[]) => !!tx),
      ).toHaveLength(0);
      nothingWritten();
    });

    it("SA-833: a contended invoice row (NOWAIT) is a retryable 409 INVOICE_BUSY and nothing is written", async () => {
      const a = line({ id: "li-a", position: 0, qty: 5 });
      seed("CONFIRMED", [a, OPEN_LINE]);
      invoices.revertLinkedInvoicesForOrderEdit.mockImplementation(
        async (_id: string, tx?: unknown) => {
          if (tx) throw new ConflictException({ code: "INVOICE_BUSY", message: "busy" });
          return [];
        },
      );
      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ id: "li-a", action: "UPDATE", qty: 4 }] } as any,
          operator,
        ),
      ).rejects.toMatchObject({ status: 409, response: { code: "INVOICE_BUSY" } });
      nothingWritten();
    });

    it("SA-833: a mirror paid between the advisory preflight and the lock is refused under the lock, nothing written", async () => {
      const a = line({ id: "li-a", position: 0, qty: 5 });
      seed("CONFIRMED", [a, OPEN_LINE]);
      // the preflight (no tx) saw an unpaid mirror; the count under the row lock finds the payment
      invoices.revertLinkedInvoicesForOrderEdit.mockImplementation(
        async (_id: string, tx?: unknown) => {
          if (tx)
            throw new BadRequestException(
              "This order can't be edited while invoice INV-1 has payments",
            );
          return [];
        },
      );
      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ id: "li-a", action: "UPDATE", qty: 4 }] } as any,
          operator,
        ),
      ).rejects.toMatchObject({ status: 400 });
      nothingWritten();
    });

    it("control: an allowed edit of an undelivered order reverts the SENT mirror inside the edit transaction, holding the invoice rows", async () => {
      const a = line({ id: "li-a", position: 0, qty: 5 });
      seed("CONFIRMED", [a, OPEN_LINE]);
      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-a", action: "UPDATE", qty: 4 }] } as any,
        operator,
      );
      expect(ownConnectionWrites()).toHaveLength(0);
      const inTx = invoices.revertLinkedInvoicesForOrderEdit.mock.calls.filter(
        ([, tx]: any[]) => !!tx,
      );
      expect(inTx).toHaveLength(1);
      expect(inTx[0][2]).toEqual({ lockRows: true });
    });
  });

  describe("(6) a note on a delivered line never reprices it (the web page's full-payload shape)", () => {
    /** The write(s) the edit made to one line, whichever writer (update / updateMany) it used. */
    const writesTo = (id: string) =>
      [...prisma.orderItem.update.mock.calls, ...prisma.orderItem.updateMany.mock.calls]
        .map(([a]: any[]) => a)
        .filter((a) => a?.where?.id === id);
    const MONEY = [
      "qty",
      "boxes",
      "pieces",
      "unitPrice",
      "subtotal",
      "promoFreeUnits",
      "unitsPerBox",
    ];

    it("a BOGO line whose live promotion would earn more free units: the note is saved, no money column is written", async () => {
      // Sold under "buy 4 get 1": 6 units, 1 free, 5 billed at $5. The live promotion is now "buy 2 get 1" (2 free).
      const bogo = line({
        id: "li-bogo",
        qty: 6,
        unitPrice: 5,
        subtotal: 25,
        promoFreeUnits: 1,
        deliveredQty: 6,
      });
      seed("PARTIALLY_DELIVERED", [bogo, OPEN_LINE]);
      promotions.activeForCatalog.mockResolvedValue([
        {
          id: "promo-1",
          type: "BUY_N_GET_M",
          value: 1,
          minQty: 2,
          scope: "ALL",
          category: null,
          productIds: [],
        },
      ]);
      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-bogo", action: "UPDATE", qty: 6, unitPrice: 5, notes: "x" }] } as any,
        operator,
      );
      const writes = writesTo("li-bogo");
      expect(writes).toHaveLength(1);
      expect(writes[0].data).toEqual({ notes: "x" });
      for (const col of MONEY) expect(writes[0].data).not.toHaveProperty(col);
    });

    it("a box-split line with no unitsPerBox snapshot: the box split is not re-derived from the live product", async () => {
      // 2 boxes of 12 = 24 units, no snapshot; the live product now says 10 per box (a re-derive would write qty 20).
      const boxed = line({
        id: "li-box",
        qty: 24,
        boxes: 2,
        pieces: 0,
        unitsPerBox: null,
        unitPrice: 12,
        subtotal: 24,
        deliveredQty: 24,
      });
      seed("PARTIALLY_DELIVERED", [boxed, OPEN_LINE]);
      prisma.product.findFirst.mockResolvedValue({ unitsPerBox: 10, category: null });
      await service.updateOrderItems(
        "ord-1",
        {
          items: [{ id: "li-box", action: "UPDATE", qty: 24, boxes: 2, pieces: 0, notes: "x" }],
        } as any,
        operator,
      );
      const writes = writesTo("li-box");
      expect(writes).toHaveLength(1);
      expect(writes[0].data).toEqual({ notes: "x" });
    });

    it("a unit-aware (Case) line: a note edit (unitLabel + productId + qty restated) never goes through updateUnitLine", async () => {
      const caseLine = line({
        id: "li-case",
        qty: 36,
        boxes: 3,
        pieces: 0,
        unitsPerBox: 12,
        unitLabel: "Case",
        unitPrice: 24,
        subtotal: 72,
        deliveredQty: 36,
      });
      seed("PARTIALLY_DELIVERED", [caseLine, OPEN_LINE]);
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-1", name: "Cola", pricePerUnit: 3, unitsPerBox: 12, trackedCategoryId: null },
        {
          id: "prod-2",
          name: "Onions",
          pricePerUnit: 5,
          unitsPerBox: null,
          trackedCategoryId: null,
        },
      ]);
      // The Case price on the live ladder moved from $24 to $30 since the sale.
      prisma.productUnit.findMany.mockResolvedValue([
        { productId: "prod-1", label: "Case", factorToBase: 12, price: 30, sortOrder: 1 },
      ]);
      await service.updateOrderItems(
        "ord-1",
        {
          items: [
            {
              id: "li-case",
              action: "UPDATE",
              productId: "prod-1",
              unitLabel: "Case",
              qty: 3,
              notes: "x",
            },
          ],
        } as any,
        operator,
      );
      const writes = writesTo("li-case");
      expect(writes).toHaveLength(1);
      expect(writes[0].data).toEqual({ notes: "x" });
    });

    it("an entry that restates the line and carries nothing else writes nothing to it", async () => {
      seed("PARTIALLY_DELIVERED", [DELIVERED_LINE, OPEN_LINE]);
      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-del", action: "UPDATE", qty: 5, unitPrice: 5 }] } as any,
        operator,
      );
      expect(writesTo("li-del")).toEqual([]);
    });

    it("a rename of a delivered UNLISTED line (the web page's {id, name, qty} shape) is saved as {name}", async () => {
      const unlisted = line({
        id: "li-unl",
        productId: null,
        name: "Delivery fee",
        qty: 1,
        deliveredQty: 1,
      });
      seed("PARTIALLY_DELIVERED", [unlisted, OPEN_LINE]);
      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-unl", action: "UPDATE", name: "Delivery fee (dock)", qty: 1 }] } as any,
        operator,
      );
      const writes = writesTo("li-unl");
      expect(writes).toHaveLength(1);
      expect(writes[0].data).toEqual({ name: "Delivery fee (dock)" });
    });

    it("a name on a delivered LISTED line writes nothing (a listed line is named by its product)", async () => {
      seed("PARTIALLY_DELIVERED", [DELIVERED_LINE, OPEN_LINE]);
      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-del", action: "UPDATE", name: "Renamed", qty: 5 }] } as any,
        operator,
      );
      expect(writesTo("li-del")).toEqual([]);
    });

    it("the undelivered line of the same order still reprices as before", async () => {
      seed("PARTIALLY_DELIVERED", [DELIVERED_LINE, OPEN_LINE]);
      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-open", action: "UPDATE", qty: 3 }] } as any,
        operator,
      );
      expect(writesTo("li-open")[0].data).toMatchObject({ qty: 3, subtotal: 15 });
    });
  });
});
