// SA-429 (#2377): these driver cases pin OTHER behaviour (pricing, merges, restrictions, returns),
// not ownership, and their mocks carry no assigned run; the ownership predicate itself is pinned by
// driver-edit-access.spec.ts and driver-edit-access.db.spec.ts.
jest.mock("./driver-edit-access", () => ({ assertDriverMayEditOrder: jest.fn() }));
/**
 * units_v1 step 4 (PR-A) — every order rewrite path refuses a unit-aware line (a line sold by a
 * non-pack unit: `unitLabel != null`) rather than re-deriving its factor/price from the LIVE
 * product. Harness copied from `orders.update-items-guards.spec.ts`. Nothing can create a
 * unit-aware line yet (no DTO accepts `unitLabel`), so these rows are fixtures.
 */

// Mock InvoicesService before it's imported — prevents Jest from traversing
// invoice-pdf.service.ts which imports @react-pdf/renderer (ESM-only module).
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({
    createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
    findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
  })),
}));

// Mock NotificationsService — it imports expo-server-sdk which is ESM-only
// and fails Jest's CommonJS parser.
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({
    sendToCustomer: jest.fn().mockResolvedValue(undefined),
    sendToDriver: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { oversellReaderOffProvider } from "./testing/policy-reader-provider";
import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException, ForbiddenException } from "@nestjs/common";
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
import { Prisma } from "@prisma/client";
import { ORDER_HAS_NO_UNIT_AWARE_LINE } from "./unit-aware-guard";

const MOCK_ORDER = {
  id: "ord-1",
  customerId: "cust-1",
  orderNumber: "ORD-123",
  status: "PENDING" as const,
  source: "APP" as const,
  urgent: false,
  subtotal: 0,
  tax: 0,
  total: 0,
  notes: null,
  driverNote: null,
  routeRunId: null,
  routeRunStopId: null,
  deliveredAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  customer: { businessName: "Acme Wholesale" },
  routeRun: null,
};

const customerPayload = {
  sub: "user-cust",
  username: "customer1",
  role: "CUSTOMER" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

const operatorPayload = {
  sub: "user-op",
  username: "operator",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

const driverPayload = {
  sub: "user-drv",
  username: "driver1",
  role: "DRIVER" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

describe("OrdersService — units_v1 fail-closed guard on rewrite paths", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let invoicesService: {
    reconcileOrderDraftInvoice: jest.Mock;
    resyncOrderInvoicesForEdit: jest.Mock;
    revertLinkedInvoicesForOrderEdit: jest.Mock;
  };
  let promotionsService: { activeForCatalog: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        oversellReaderOffProvider,
        OrdersService,
        {
          provide: TenantContextService,
          // B323: sweepAllPendingOrders() now takes TenantContextService; this spec never
          // exercises the sweep, so a bare run-through mock is enough to satisfy DI.
          useValue: { run: (_tenantId: string | null, fn: () => unknown) => fn() },
        },
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
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(0.1) } },
        {
          provide: InvoicesService,
          useValue: {
            createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
            createInvoiceFromOrder: jest
              .fn()
              .mockResolvedValue([{ id: "inv-1", invoiceNumber: "INV-1", total: 0 }]),
            createInvoiceFromOrderWithTenant: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
            send: jest.fn().mockResolvedValue({ id: "inv-1", status: "SENT" }),
            findOpenOrderDraft: jest.fn().mockResolvedValue(null),
            reconcileOrderDraftInvoice: jest.fn().mockResolvedValue({ id: "inv-1" }),
            resyncOrderInvoicesForEdit: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
            revertLinkedInvoicesForOrderEdit: jest.fn().mockResolvedValue([]),
            voidInvoice: jest.fn().mockResolvedValue({ id: "inv-1", status: "VOID" }),
            voidInvoiceInTx: jest.fn().mockResolvedValue({ id: "inv-1", status: "VOID" }),
            releaseWalletPaymentsInTx: jest.fn().mockResolvedValue({ credits: [], advances: 0 }),
          },
        },
        {
          provide: SystemConfigService,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue(undefined),
            getAll: jest.fn().mockResolvedValue({}),
          },
        },
        {
          provide: NotificationsService,
          useValue: {
            sendToCustomer: jest.fn().mockResolvedValue(undefined),
            sendToDriver: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: InventoryService,
          useValue: {
            recordSale: jest.fn().mockResolvedValue({
              unitCost: new Prisma.Decimal(0),
              stockAfter: new Prisma.Decimal(0),
            }),
          },
        },
        {
          provide: SellingRestrictionsService,
          useValue: {
            assertLinesSellable: jest.fn().mockResolvedValue(undefined),
            checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "OFF", reasons: [] }),
            getPolicy: jest.fn().mockResolvedValue({ enabled: false }),
          },
        },
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
        {
          provide: PromotionsService,
          useValue: { activeForCatalog: jest.fn().mockResolvedValue([]) },
        },
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
            validateSelectionsForCustomer: jest.fn().mockResolvedValue(undefined),
            syncOrderCreditSelections: jest.fn().mockResolvedValue(undefined),
            settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
            releaseOrderCreditsInTx: jest.fn().mockResolvedValue([]),
            previewOrderCreditRelease: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: EntitlementsService,
          useValue: { hasFlag: jest.fn().mockResolvedValue(true) },
        },
        // B65: deleteOrder's per-invoice teardown reverses regulated-ledger entries.
        {
          provide: RegulatedLedgerService,
          useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
    invoicesService = module.get(InvoicesService);
    promotionsService = module.get(PromotionsService);
  });

  const unitAwareOrder = (extra: Record<string, unknown> = {}) => ({
    ...MOCK_ORDER,
    status: "PENDING",
    lineItems: [
      {
        id: "li-case",
        orderId: "ord-1",
        productId: "prod-box",
        qty: 288,
        unitPrice: 480,
        subtotal: 480,
        status: "PENDING",
        boxes: 1,
        pieces: 0,
        unitsPerBox: 288,
        unitLabel: "Case",
        priceType: "STANDARD",
        originalPrice: null,
        ...extra,
      },
    ],
  });

  describe("updateOrderItems refuses an order holding a unit-aware line (409 UNIT_AWARE_LINE)", () => {
    // units_v1 (A1): staff is CONVERTED, not blanket-guarded, for every shape EXCEPT
    // `replaceAll: true` — a full replace re-denominates every line by productId alone (the
    // replace-all branch has no per-line id to preserve a unit through), which would silently
    // collapse a Case line to the pack's price. So "staff replace-all" is BACK in this table
    // (hardening round, coordinator-reviewed): refused the same as CUSTOMER/DRIVER, now via the
    // guard's own replaceAll check rather than the old blanket rule. "staff diff qty edit" is
    // refused for the money-seam reason instead — it names an EXISTING unit-aware line by id with
    // no unitLabel, via assertUnitLabelNamed, not this guard.
    const payloads = [
      [
        "staff replace-all (re-denomination refusal — the guard's own replaceAll check)",
        operatorPayload,
        { replaceAll: true, items: [{ productId: "prod-box", qty: 2 }] },
      ],
      [
        "staff diff qty edit (no unitLabel named — the money seam, not this guard)",
        operatorPayload,
        { replaceAll: false, items: [{ id: "li-case", qty: 3 }] },
      ],
      ["buyer replace-all", customerPayload, { items: [{ productId: "prod-box", qty: 2 }] }],
      [
        "driver diff edit",
        driverPayload,
        { replaceAll: false, items: [{ id: "li-case", qty: 3 }] },
      ],
    ] as const;

    it.each(payloads)("%s", async (_n, user, dto) => {
      prisma.order.findUnique.mockResolvedValue(unitAwareOrder());
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" }); // the buyer OWNS the order
      const err = await service
        .updateOrderItems("ord-1", dto as never, user as never)
        .catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ code: "UNIT_AWARE_LINE" });
      expect(err.getResponse().message).toContain("Case");
      // Nothing was written.
      expect(prisma.orderItem.deleteMany).not.toHaveBeenCalled();
      expect(prisma.orderItem.create).not.toHaveBeenCalled();
      expect(prisma.orderItem.update).not.toHaveBeenCalled();
    });

    it("Opus delta item 6: a STAFF qty edit of a CANCELLED Case line naming no unit is refused BEFORE any invoice/mirror write", async () => {
      // SA-422b(b) dropped cancelled lines from the pre-lock unit map for EVERY role, while the
      // lock-time map kept them: the pre-lock check passed, revertLinkedInvoicesForOrderEdit
      // committed on its own connection, and only the in-tx 409 followed — a SENT invoice's
      // mirror stranded in DRAFT. Staff keep every line in the pre-lock map.
      prisma.order.findUnique.mockResolvedValue(unitAwareOrder({ status: "CANCELLED" }));
      const err = await service
        .updateOrderItems(
          "ord-1",
          { replaceAll: false, items: [{ id: "li-case", qty: 3 }] } as never,
          operatorPayload as never,
        )
        .catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ code: "UNIT_AWARE_LINE" });
      expect(invoicesService.revertLinkedInvoicesForOrderEdit).not.toHaveBeenCalled();
    });

    it.each([
      ["SUPER_ADMIN", { ...operatorPayload, role: "SUPER_ADMIN" }],
      ["a missing user", undefined],
    ])(
      "Opus delta (0bebefad): %s editing a CANCELLED Case line is refused BEFORE any invoice/mirror write",
      async (_who, user) => {
        prisma.order.findUnique.mockResolvedValue(unitAwareOrder({ status: "CANCELLED" }));
        const err = await service
          .updateOrderItems(
            "ord-1",
            { replaceAll: false, items: [{ id: "li-case", qty: 3 }] } as never,
            user as never,
          )
          .catch((e) => e);
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.getResponse()).toMatchObject({ code: "UNIT_AWARE_LINE" });
        expect(invoicesService.revertLinkedInvoicesForOrderEdit).not.toHaveBeenCalled();
      },
    );

    it("a CANCELLED unit-aware line does not trip the guard (the edit proceeds past it)", async () => {
      prisma.order.findUnique.mockResolvedValue(unitAwareOrder({ status: "CANCELLED" }));
      const err = await service
        .updateOrderItems(
          "ord-1",
          { replaceAll: true, items: [] } as never,
          operatorPayload as never,
        )
        .catch((e) => e);
      expect(err?.getResponse?.()?.code).not.toBe("UNIT_AWARE_LINE");
    });
  });

  describe("updateOrderItems guard scope", () => {
    it("a diff of ONLY CANCEL/DELETE entries is not refused (the operator's way to remove a mistaken Case line)", async () => {
      prisma.order.findUnique.mockResolvedValue(unitAwareOrder());
      const err = await service
        .updateOrderItems(
          "ord-1",
          { replaceAll: false, items: [{ id: "li-case", action: "CANCEL" }] } as never,
          operatorPayload as never,
        )
        .catch((e) => e);
      expect(err?.getResponse?.()?.code).not.toBe("UNIT_AWARE_LINE");
    });

    it("but a mixed diff (cancel of one line + a qty edit naming no unitLabel on the unit-aware line) IS refused — units_v1 (A1): via assertUnitLabelNamed now, same code/message", async () => {
      prisma.order.findUnique.mockResolvedValue(unitAwareOrder());
      const err = await service
        .updateOrderItems(
          "ord-1",
          {
            replaceAll: false,
            items: [
              { id: "li-other", action: "CANCEL" },
              { id: "li-case", qty: 3 },
            ],
          } as never,
          operatorPayload as never,
        )
        .catch((e) => e);
      expect(err.getResponse()).toMatchObject({ code: "UNIT_AWARE_LINE" });
    });

    it("a NON-owner buyer gets the bare 403, never a 409 naming a unit on someone else's order", async () => {
      prisma.order.findUnique.mockResolvedValue(unitAwareOrder());
      prisma.customer.findFirst.mockResolvedValue({ id: "someone-else" });
      const err = await service
        .updateOrderItems(
          "ord-1",
          { items: [{ productId: "prod-box", qty: 2 }] } as never,
          customerPayload as never,
        )
        .catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
    });

    it("the OWNER buyer gets the readable 409", async () => {
      prisma.order.findUnique.mockResolvedValue(unitAwareOrder());
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      const err = await service
        .updateOrderItems(
          "ord-1",
          { items: [{ productId: "prod-box", qty: 2 }] } as never,
          customerPayload as never,
        )
        .catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
    });
  });

  describe("findActiveOrder never proposes an order holding a unit-aware line as a merge target", () => {
    it("display reads (default) stay UNFILTERED — a buyer must still see their open order", async () => {
      prisma.order.findFirst.mockResolvedValue(null);
      await service.findActiveOrder("cust-1");
      const where = prisma.order.findFirst.mock.calls[0][0].where;
      expect(where).not.toHaveProperty("lineItems");
      expect(where).toMatchObject({ customerId: "cust-1" });
    });

    it("adds the no-unit-aware-line filter to the query for a MERGE decision", async () => {
      prisma.order.findFirst.mockResolvedValue(null);
      await service.findActiveOrder("cust-1", { forMerge: true });
      expect(prisma.order.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ ...ORDER_HAS_NO_UNIT_AWARE_LINE, customerId: "cust-1" }),
        }),
      );
    });
  });
});
