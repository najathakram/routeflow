/**
 * Returns Inside Order Creation — PR-1c (design.md §4/§6.4, M7): `updateOrderItems`'s
 * DRIVER edit-down guard. A DRIVER edit that would drop the order's gross below the credit
 * already issued/held against its own inline returns (`sumInlineReturnCredit`,
 * `inline-return-credit.util.ts`) is refused with `ORDER_BELOW_RETURN_CREDIT`, read right
 * after the `Order FOR UPDATE` the qty-edit itself takes. Harness copied from
 * `orders.update-items-guards.spec.ts` (same mocked-Prisma provider set).
 *
 * Fix-revert probe: comment out the `if (user?.role === UserRole.DRIVER) { … }` block this
 * spec targets (orders.service.ts, right after `total` is computed) — every `it()` below
 * that expects a 400 goes green regardless (a DRIVER edit-down would silently succeed),
 * proving the tests actually exercise the guard rather than some unrelated refusal.
 */

jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({
    createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
    findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
  })),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({
    sendToCustomer: jest.fn().mockResolvedValue(undefined),
    sendToDriver: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
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
import { PromotionsService } from "../promotions/promotions.service";
import { MessagingService } from "../messaging/messaging.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";

const MOCK_ORDER = {
  id: "ord-1",
  customerId: "cust-1",
  orderNumber: "ORD-123",
  // DRAFT so the settleStockForEdit/assertWithinCreditLimit block (gated on
  // `order.status !== "DRAFT"`) never runs — this spec targets ONLY the guard, which sits
  // BEFORE that block.
  status: "DRAFT" as const,
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

const driverPayload = {
  sub: "user-drv",
  username: "driver1",
  role: "DRIVER" as const,
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

describe("OrdersService.updateOrderItems — DRIVER edit-down vs. inline-return credit (PR-1c §4/§6.4)", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        {
          provide: TenantContextService,
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
          useValue: { recordSale: jest.fn() },
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
          useValue: { notify: jest.fn().mockResolvedValue([]), notifyEvent: jest.fn() },
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
          useValue: { syncInvoiceCommissionSafe: jest.fn(), syncOrderInvoices: jest.fn() },
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(true) } },
        {
          provide: RegulatedLedgerService,
          useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
  });

  // `orderItem.findMany` backs the POST-edit "recalculate order totals from all
  // non-cancelled items" read — since this is a static mock (not a real DB), it must be
  // primed with what the edit is EXPECTED to leave behind, not the pre-edit snapshot
  // `order.findUnique` returns (same convention `orders.update-items-guards.spec.ts`'s T8
  // uses). `postEditLines` defaults to the pre-edit line when an edit is a no-op.
  function primeOrder(preEditLine: any, postEditLines: any[] = [preEditLine]) {
    prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: [preEditLine] });
    prisma.orderItem.findMany.mockResolvedValue(postEditLines);
    prisma.product.findMany.mockResolvedValue([
      {
        id: "prod-1",
        pricePerUnit: 5,
        unitsPerBox: null,
        category: null,
        trackedCategoryId: null,
        trackedSubcategoryId: null,
      },
    ]);
  }

  const EXISTING_LINE = {
    id: "li-1",
    orderId: "ord-1",
    productId: "prod-1",
    qty: 10,
    unitPrice: 5,
    subtotal: 50,
    status: "PENDING",
    boxes: null,
    pieces: null,
    priceType: "STANDARD",
    originalPrice: null,
  };

  it("REFUSES a DRIVER edit that drops the order's gross ($20.00) below the $50.00 already issued/held against its inline returns", async () => {
    // Edit down to 4 units ($20.00) — below the committed $50.00.
    primeOrder(EXISTING_LINE, [{ ...EXISTING_LINE, qty: 4, subtotal: 20 }]);
    // Two non-cancelled INLINE returns on this order already committed $30 (issued) +
    // $20 (driver-cap held) = $50.00 — sumInlineReturnCredit sums refundAmount ??
    // heldAmount per row.
    prisma.return.findMany.mockResolvedValue([
      { refundAmount: 30, heldAmount: null },
      { refundAmount: null, heldAmount: 20 },
    ]);

    const attempt = service.updateOrderItems(
      "ord-1",
      { items: [{ productId: "prod-1", qty: 4 }] },
      driverPayload,
    );

    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    await expect(attempt).rejects.toMatchObject({
      response: expect.objectContaining({ code: "ORDER_BELOW_RETURN_CREDIT" }),
    });
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it("ALLOWS the identical DRIVER edit when the resulting gross ($50.00) still covers the committed credit ($50.00)", async () => {
    primeOrder(EXISTING_LINE); // no-op edit: postEditLines defaults to [EXISTING_LINE] ($50.00)
    prisma.return.findMany.mockResolvedValue([
      { refundAmount: 30, heldAmount: null },
      { refundAmount: null, heldAmount: 20 },
    ]);

    await expect(
      service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-1", qty: 10 }] },
        driverPayload,
      ),
    ).resolves.toBeDefined();
    expect(prisma.order.update).toHaveBeenCalled();
  });

  it("does NOT gate an OPERATOR edit that drops the gross below the same committed credit — only DRIVER is capped", async () => {
    primeOrder(EXISTING_LINE, [{ ...EXISTING_LINE, qty: 1, subtotal: 5 }]);
    prisma.return.findMany.mockResolvedValue([{ refundAmount: 50, heldAmount: null }]);

    await expect(
      service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-1", qty: 1 }] },
        operatorPayload,
      ),
    ).resolves.toBeDefined();
    expect(prisma.order.update).toHaveBeenCalled();
  });

  it("never gates a DRIVER edit when the order carries no inline-return credit at all (the common case)", async () => {
    primeOrder(EXISTING_LINE, [{ ...EXISTING_LINE, qty: 1, subtotal: 5 }]);
    prisma.return.findMany.mockResolvedValue([]);

    await expect(
      service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-1", qty: 1 }] },
        driverPayload,
      ),
    ).resolves.toBeDefined();
  });
});
