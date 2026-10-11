/**
 * #2404 (P0, epic #2400): `InvoicePayment` carries only `creditNoteId` (no Prisma relation), so
 * the order detail never said WHICH credit a payment was — and the order's "Applied credits"
 * panel could not show a credit that was auto-applied without an intent. `findOne` now attaches
 * each credit payment's credit-note number and reason with ONE batched, tenant-scoped read.
 * Sibling spec (own module setup): orders.service.spec.ts is at its size-ratchet cap.
 */

// Mock InvoicesService before it's imported — prevents Jest from traversing
// invoice-pdf.service.ts which imports @react-pdf/renderer (ESM-only module).
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({
    createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
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

const operatorPayload = {
  sub: "user-op",
  username: "operator1",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
  tenantId: "tenant-1",
  tenantSlug: "acme",
};

const orderWith = (invoices: unknown[]) => ({
  id: "ord-1",
  customerId: "cust-1",
  orderNumber: "ORD-1",
  status: "DELIVERED",
  routeRun: null,
  invoices,
  orderCreditNotes: [],
});

describe("OrdersService.findOne — credit payments carry their credit note (#2404)", () => {
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
          useValue: { createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }) },
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
        { provide: InventoryService, useValue: { recordSale: jest.fn() } },
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: AuthorizationGuardService,
          useValue: { assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PromotionsService, useValue: { activeForCatalog: jest.fn() } },
        {
          provide: MessagingService,
          useValue: { notify: jest.fn(), notifyEvent: jest.fn() },
        },
        {
          provide: CreditNotesService,
          useValue: {
            validateSelectionsForCustomer: jest.fn(),
            syncOrderCreditSelections: jest.fn(),
          },
        },
        {
          provide: CommissionEngineService,
          useValue: { syncInvoiceCommissionSafe: jest.fn() },
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(true) } },
        {
          provide: RegulatedLedgerService,
          useValue: { reverseInvoiceEntries: jest.fn(), syncInvoiceEntries: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
  });

  it("attaches number + reason to every credit payment, one batched read, ids de-duplicated", async () => {
    prisma.order.findUnique.mockResolvedValue(
      orderWith([
        {
          id: "inv-1",
          payments: [
            { id: "p1", amount: "12.50", creditNoteId: "cn-a" },
            { id: "p2", amount: "5.00", creditNoteId: "cn-b" },
          ],
        },
        { id: "inv-2", payments: [{ id: "p3", amount: "3.25", creditNoteId: "cn-b" }] },
      ]),
    );
    prisma.creditNote.findMany.mockResolvedValue([
      { id: "cn-a", creditNoteNumber: "CN-A", reason: "old test credit" },
      { id: "cn-b", creditNoteNumber: "CN-B", reason: null },
    ]);

    const order = (await service.findOne("ord-1", operatorPayload)) as any;

    expect(prisma.creditNote.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.creditNote.findMany.mock.calls[0][0];
    expect([...arg.where.id.in].sort()).toEqual(["cn-a", "cn-b"]);
    expect(arg.select).toEqual({
      id: true,
      creditNoteNumber: true,
      reason: true,
      autoApplied: true,
    });
    expect(order.invoices[0].payments[0].creditNote).toEqual({
      id: "cn-a",
      creditNoteNumber: "CN-A",
      reason: "old test credit",
    });
    expect(order.invoices[1].payments[0].creditNote.creditNoteNumber).toBe("CN-B");
  });

  it("a payment whose credit note is not readable gets creditNote: null", async () => {
    prisma.order.findUnique.mockResolvedValue(
      orderWith([{ id: "inv-1", payments: [{ id: "p1", amount: "1", creditNoteId: "cn-gone" }] }]),
    );
    prisma.creditNote.findMany.mockResolvedValue([]);
    const order = (await service.findOne("ord-1", operatorPayload)) as any;
    expect(order.invoices[0].payments[0].creditNote).toBeNull();
  });

  it("no credit payments ⇒ no extra read", async () => {
    prisma.order.findUnique.mockResolvedValue(orderWith([{ id: "inv-1", payments: [] }]));
    await service.findOne("ord-1", operatorPayload);
    expect(prisma.creditNote.findMany).not.toHaveBeenCalled();
  });

  it("the order read selects each credit payment's autoApplied (SA-436 PR-1 column, #2404)", async () => {
    prisma.order.findUnique.mockResolvedValue(orderWith([]));
    await service.findOne("ord-1", operatorPayload);
    const include = prisma.order.findUnique.mock.calls[0][0].include;
    expect(include.invoices.select.payments.select).toEqual(
      expect.objectContaining({
        id: true,
        amount: true,
        creditNoteId: true,
        autoApplied: true,
        createdAt: true,
      }),
    );
  });
});
