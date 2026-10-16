/**
 * Units S19 — `updateOrderItems`. Harness copied from
 * `orders.unit-aware-guard.spec.ts` (same DI shape). Units S19 (flag.units_prices_v2): the staff edit paths price a NEW line
 * from the customer's TYPED unit price (diff-add pack + Case, replace-all pack) and judge a typed price against it;
 * flag off, or no typed row: master's price. Pure seams: units-prices-v2.spec.ts.
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

import { oversellReaderOffProvider } from "./testing/policy-reader-provider";
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
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

const operatorPayload = {
  sub: "user-op",
  username: "operator",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

// A Case (factor 12) off a boxed pack. `price: 100` is an explicit per-Case list price (a genuine
// case discount off 12 x pricePerUnit=10=120), so an echoed 100 must classify STANDARD, not MANUAL.
const caseProduct = {
  id: "prod-case",
  unit: "Box",
  unitsPerBox: 12,
  pricePerUnit: 10,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  trackedCategoryId: null,
  trackedSubcategoryId: null,
};
const caseLadderRow = {
  productId: "prod-case",
  label: "Case",
  factorToBase: 12,
  price: 100,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  isDefaultSelling: false,
  sortOrder: 1,
};

const existingCaseLine = {
  id: "li-case",
  orderId: "ord-1",
  productId: "prod-case",
  name: null,
  qty: 24, // 2 Cases x 12
  boxes: 2,
  pieces: 0,
  unitsPerBox: 12,
  unitLabel: "Case",
  unitPrice: 100,
  subtotal: 200,
  status: "PENDING",
  deliveredQty: 0,
  invoicedQty: 0,
  priceType: "STANDARD",
  originalPrice: null,
  overrideReason: null,
  overriddenBy: null,
  promoFreeUnits: null,
  trackedCategoryId: null,
  position: 0,
};

const existingPackLine = {
  id: "li-pack",
  orderId: "ord-1",
  productId: "prod-pack",
  name: null,
  qty: 5,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
  unitPrice: 3,
  subtotal: 15,
  status: "PENDING",
  deliveredQty: 0,
  invoicedQty: 0,
  priceType: "STANDARD",
  originalPrice: null,
  overrideReason: null,
  overriddenBy: null,
  promoFreeUnits: null,
  trackedCategoryId: null,
  position: 1,
};

// B297 (SA-098a) fixtures — a regulated Case product + its stamped line + the live category
// a stale-rate trio must NOT be re-derived from.
const regulatedCaseProduct = { ...caseProduct, id: "prod-case-reg", trackedCategoryId: "cat-1" };
const regulatedCaseLadderRow = { ...caseLadderRow, productId: "prod-case-reg" };
const existingRegulatedCaseLine = {
  ...existingCaseLine,
  id: "li-case-reg",
  productId: "prod-case-reg",
  trackedCategoryId: "cat-1",
  categoryTaxType: "EXCISE_PER_UNIT",
  categoryTaxRate: 0.3,
  categoryPriceIncludesTax: false,
};
const liveCategory = {
  id: "cat-1",
  taxType: "EXCISE_PER_UNIT",
  rate: 0.5,
  priceIncludesTax: false,
};

describe("OrdersService.updateOrderItems — billing reads typed customer unit prices (S19)", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let entitlements: { hasFlag: jest.Mock };
  let invoicesService: { revertLinkedInvoicesForOrderEdit: jest.Mock };

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
            followPartialPrices: jest.fn().mockResolvedValue({ issuedPartialsUnchanged: [] }),
            projectEditedInvoiceTotals: jest.fn().mockResolvedValue([]),
            revertLinkedInvoicesForOrderEdit: jest.fn().mockResolvedValue([]),
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
            releaseOrderCreditsInTx: jest.fn().mockResolvedValue([]),
            settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
            syncOrderCreditSelections: jest.fn().mockResolvedValue(undefined),
            previewOrderCreditRelease: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: CommissionEngineService,
          useValue: {
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(true) } },
        {
          provide: RegulatedLedgerService,
          useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
    entitlements = module.get(EntitlementsService);
    invoicesService = module.get(InvoicesService);

    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    prisma.product.findMany.mockResolvedValue([caseProduct]);
    prisma.product.findUniqueOrThrow.mockResolvedValue(caseProduct);
    prisma.productUnit.findMany.mockResolvedValue([caseLadderRow]);
  });

  const V2 = "flag.units_prices_v2";
  const typed = (...rows: Array<[string, number]>) => {
    (prisma.forTenant() as any).customerUnitPrice = {
      findMany: jest
        .fn()
        .mockResolvedValue(
          rows.map(([unitRef, price]) => ({ productId: "prod-case", unitRef, price })),
        ),
    };
  };
  const flagV2 = (on: boolean) =>
    entitlements.hasFlag.mockImplementation(async (_t: string, k: string) => k !== V2 || on);
  const written = () => prisma.orderItem.create.mock.calls.map((c) => c[0].data);
  const addPack = () =>
    service.updateOrderItems(
      "ord-1",
      { replaceAll: false, items: [{ productId: "prod-case", qty: 2 }] } as never,
      operatorPayload as never,
    );

  beforeEach(() => {
    prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: [existingPackLine] });
    prisma.productUnit.findMany.mockResolvedValue([{ ...caseLadderRow, id: "u-case" }]);
  });

  it("flag on: a NEW pack line takes the typed pack price (diff-add), SPECIAL against list", async () => {
    flagV2(true);
    typed(["pack", 8]);
    await addPack();
    expect(written()[0]).toMatchObject({
      productId: "prod-case",
      unitPrice: 8,
      originalPrice: 10,
      priceType: "SPECIAL",
    });
  });

  it("flag on: a NEW Case line takes the typed Case price (its ProductUnit id)", async () => {
    flagV2(true);
    typed(["u-case", 90]);
    await service.updateOrderItems(
      "ord-1",
      {
        replaceAll: false,
        items: [{ productId: "prod-case", unitLabel: "Case", qty: 2 }],
      } as never,
      operatorPayload as never,
    );
    expect(written()[0]).toMatchObject({ unitLabel: "Case", unitPrice: 90, qty: 24 });
  });

  it("flag on: a replace-all pack line takes the typed pack price", async () => {
    flagV2(true);
    typed(["pack", 8]);
    await service.updateOrderItems(
      "ord-1",
      { replaceAll: true, items: [{ productId: "prod-case", qty: 2 }] } as never,
      operatorPayload as never,
    );
    expect(written()[0]).toMatchObject({
      productId: "prod-case",
      unitPrice: 8,
      priceType: "SPECIAL",
    });
  });

  it("flag on: a staff-typed price below the typed baseline needs a reason (the baseline is the typed price, not list)", async () => {
    flagV2(true);
    typed(["pack", 8]);
    await expect(
      service.updateOrderItems(
        "ord-1",
        { replaceAll: false, items: [{ productId: "prod-case", qty: 2, unitPrice: 7 }] } as never,
        operatorPayload as never,
      ),
    ).rejects.toThrow(/reason/i);
  });

  it("flag OFF with typed rows present: master's prices (pack 10, Case 100), rows ignored", async () => {
    flagV2(false);
    typed(["pack", 8], ["u-case", 90]);
    await addPack();
    expect(written()[0]).toMatchObject({ unitPrice: 10, priceType: "STANDARD" });
    prisma.orderItem.create.mockClear();
    await service.updateOrderItems(
      "ord-1",
      {
        replaceAll: false,
        items: [{ productId: "prod-case", unitLabel: "Case", qty: 2 }],
      } as never,
      operatorPayload as never,
    );
    expect(written()[0]).toMatchObject({ unitLabel: "Case", unitPrice: 100 });
  });

  it("flag on but NO typed row for the customer: master's price, and the new flag is never asked", async () => {
    flagV2(true);
    typed();
    await addPack();
    expect(written()[0]).toMatchObject({ unitPrice: 10 });
    expect(entitlements.hasFlag).not.toHaveBeenCalledWith(expect.anything(), V2);
  });

  it("flag on: a SUBSTITUTE line takes the substitute product's typed pack price (SPECIAL), flag off master's", async () => {
    flagV2(true);
    typed(["pack", 8]);
    const sub = () =>
      service.updateOrderItems(
        "ord-1",
        {
          replaceAll: false,
          items: [{ id: "li-pack", substituteProductId: "prod-case", qty: 2 }],
        } as never,
        operatorPayload as never,
      );
    await sub();
    expect(prisma.orderItem.update.mock.calls.at(-1)![0].data).toMatchObject({
      productId: "prod-case",
      unitPrice: 8,
      priceType: "SPECIAL",
    });
    flagV2(false);
    await sub();
    expect(prisma.orderItem.update.mock.calls.at(-1)![0].data).toMatchObject({
      unitPrice: 10,
      priceType: "STANDARD",
    });
  });

  describe("an EXISTING pack line's price edit is judged against the customer layer", () => {
    const packLine = {
      ...existingPackLine,
      id: "li-pk2",
      productId: "prod-case",
      unitPrice: 8,
      priceType: "SPECIAL",
      originalPrice: 10,
    };
    const edit = (unitPrice: number) =>
      service.updateOrderItems(
        "ord-1",
        { replaceAll: false, items: [{ id: "li-pk2", qty: 5, unitPrice }] } as never,
        operatorPayload as never,
      );
    beforeEach(() => {
      prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: [packLine] });
      prisma.product.findFirst.mockResolvedValue(caseProduct);
    });
    it("flag on: moving a customer-layer price needs a reason", async () => {
      flagV2(true);
      typed(["pack", 8]);
      await expect(edit(7)).rejects.toThrow(/reason/i);
    });
    it("flag OFF with typed rows: master's tier-1 line takes a below-list price with no reason (DISCOUNTED)", async () => {
      flagV2(false);
      typed(["pack", 8]);
      await edit(7);
      expect(prisma.orderItem.update.mock.calls.at(-1)![0].data).toMatchObject({
        unitPrice: 7,
        priceType: "DISCOUNTED",
      });
    });
  });
});
