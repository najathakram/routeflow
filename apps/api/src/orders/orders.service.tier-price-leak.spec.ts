/**
 * SA-085f security fix: `findOne`'s product select was widened with priceTier2-5 so the
 * mobile unit picker's ladder could price off the real product (units_v1, HIGH #2).
 * `findOne` is the SAME method buyer.controller.ts's `GET orders/:id` calls
 * (makePseudoUser defaults role: CUSTOMER); its CUSTOMER branch already calls
 * redactUpsellForCustomer, but that only strips pricePerUnit/averageCost — never the tier
 * columns. A buyer would have received the product's OTHER pricing tiers on their own
 * order detail, which are effectively other customers' negotiated prices. This is a
 * SIBLING spec (own module setup) rather than an addition to orders.service.spec.ts,
 * which is already at its size-ratchet cap — same reason
 * orders.service.tracking-contract.spec.ts exists. Module setup copied from there.
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
import type { JwtPayload } from "../auth/jwt-payload.interface";

const MOCK_ORDER = {
  id: "ord-1",
  customerId: "cust-1",
  orderNumber: "ORD-123",
  status: "PENDING" as const,
  source: "APP" as const,
  urgent: false,
  subtotal: 14.97,
  tax: 1.5,
  total: 16.47,
  notes: null,
  driverNote: null,
  routeRunId: null,
  routeRunStopId: null,
  deliveredAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  customer: { businessName: "Test Business" },
};

// Complete JwtPayloads (B806: specs are type-checked now, so a mock missing a required field fails).
const operatorPayload: JwtPayload = {
  sub: "user-op",
  username: "operator1",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
  tenantId: "test-tenant",
  tenantSlug: "test",
};

const customerPayload: JwtPayload = {
  sub: "user-cust",
  username: "customer1",
  role: "CUSTOMER" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
  tenantId: "test-tenant",
  tenantSlug: "test",
};

describe("OrdersService.findOne — tier-price leak (SA-085f)", () => {
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
        { provide: RegulatedLedgerService, useValue: { reverseInvoiceEntries: jest.fn() } },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
  });

  it("selects priceTier2-5 for an OPERATOR read, but NEVER for a CUSTOMER read", async () => {
    prisma.order.findUnique.mockResolvedValue(MOCK_ORDER);
    await service.findOne("ord-1", operatorPayload);
    const operatorSelect =
      prisma.order.findUnique.mock.calls.at(-1)![0].include.lineItems.include.product.select;
    expect(operatorSelect).toEqual(
      expect.objectContaining({
        priceTier2: true,
        priceTier3: true,
        priceTier4: true,
        priceTier5: true,
      }),
    );

    prisma.order.findUnique.mockResolvedValue(MOCK_ORDER);
    prisma.customer.findFirst.mockResolvedValue({ id: MOCK_ORDER.customerId });
    await service.findOne("ord-1", customerPayload);
    const customerSelect =
      prisma.order.findUnique.mock.calls.at(-1)![0].include.lineItems.include.product.select;
    expect(customerSelect.priceTier2).toBeUndefined();
    expect(customerSelect.priceTier3).toBeUndefined();
    expect(customerSelect.priceTier4).toBeUndefined();
    expect(customerSelect.priceTier5).toBeUndefined();
    // pricePerUnit/unitsPerBox are unaffected — this gate is scoped to the tier columns only.
    expect(customerSelect).toEqual(
      expect.objectContaining({ pricePerUnit: true, unitsPerBox: true }),
    );
  });
});
