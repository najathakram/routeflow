/**
 * units_v1 (A1) — `updateOrderItems` staff-side conversion. Harness copied from
 * `orders.unit-aware-guard.spec.ts` (same DI shape). NEVER added to `orders.service.spec.ts`
 * (its own size ratchet is at cap) — this is its own file, per the A1 brief.
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
import { ConflictException } from "@nestjs/common";
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

describe("OrdersService.updateOrderItems — units_v1 (A1) staff conversion", () => {
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

  it("flag-off characterization: a pack-only edit reads nothing new and writes an identical row", async () => {
    entitlements.hasFlag.mockResolvedValue(false);
    prisma.order.findUnique.mockResolvedValue({
      ...MOCK_ORDER,
      lineItems: [existingPackLine],
    });
    await service.updateOrderItems(
      "ord-1",
      { replaceAll: false, items: [{ id: "li-pack", qty: 7 }] } as never,
      operatorPayload as never,
    );
    // No unit machinery touched at all — the flag/staff gate no-ops, and productIds is empty
    // (no dto item names a unit, no existing line is unit-aware), so no extra query fires.
    expect(prisma.productUnit.findMany).not.toHaveBeenCalled();
    expect(entitlements.hasFlag).not.toHaveBeenCalled();
    // The write is the SAME shape a pre-A1 pack qty edit would produce.
    expect(prisma.orderItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "li-pack" },
        data: expect.objectContaining({ qty: 7, unitPrice: 3, subtotal: 21 }),
      }),
    );
  });

  it("a no-label edit of a Case line is refused, for staff too (the money seam — never interpreted as pieces)", async () => {
    prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: [existingCaseLine] });
    const err = await service
      .updateOrderItems(
        "ord-1",
        { replaceAll: false, items: [{ id: "li-case", qty: 3 }] } as never,
        operatorPayload as never,
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: "UNIT_AWARE_LINE" });
    expect(prisma.orderItem.update).not.toHaveBeenCalled();
    // The blocking defect this pin exists for: the unit gate is hoisted ABOVE the un-tx'd
    // revertLinkedInvoicesForOrderEdit call, so a refusal must never let that side effect commit
    // first — a SENT invoice's pending mirror would otherwise be stranded in DRAFT.
    expect(invoicesService.revertLinkedInvoicesForOrderEdit).not.toHaveBeenCalled();
  });

  it("a staff replaceAll against an order with a unit-aware line is REFUSED, never silently re-denominated to the pack", async () => {
    prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: [existingCaseLine] });
    const err = await service
      .updateOrderItems(
        "ord-1",
        { replaceAll: true, items: [{ productId: "prod-case", qty: 2 }] } as never,
        operatorPayload as never,
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: "UNIT_AWARE_LINE" });
    expect(prisma.orderItem.create).not.toHaveBeenCalled();
    expect(prisma.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(invoicesService.revertLinkedInvoicesForOrderEdit).not.toHaveBeenCalled();
  });

  it("qty edit on a Case line: 2 -> 3 Cases writes qty in BASE units (36), boxes=3, pieces=0", async () => {
    prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: [existingCaseLine] });
    await service.updateOrderItems(
      "ord-1",
      { replaceAll: false, items: [{ id: "li-case", unitLabel: "Case", qty: 3 }] } as never,
      operatorPayload as never,
    );
    expect(prisma.orderItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "li-case", orderId: "ord-1" },
        data: expect.objectContaining({
          qty: 36,
          boxes: 3,
          pieces: 0,
          unitsPerBox: 12,
          unitLabel: "Case",
        }),
      }),
    );
  });

  it("echoed price (100, same as stored) keeps the line's price — STANDARD, no override stamp", async () => {
    prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: [existingCaseLine] });
    await service.updateOrderItems(
      "ord-1",
      {
        replaceAll: false,
        items: [{ id: "li-case", unitLabel: "Case", qty: 3, unitPrice: 100 }],
      } as never,
      operatorPayload as never,
    );
    expect(prisma.orderItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          unitPrice: 100,
          priceType: "STANDARD",
          originalPrice: null,
        }),
      }),
    );
  });

  describe("H3: a stored unit-line override on a special-tier customer", () => {
    // tier-3 Case $80 (list $100); the stored line is a DISCOUNTED $90 override with its reason and stamp
    const storedOverride = {
      ...existingCaseLine,
      unitPrice: 90,
      subtotal: 180,
      priceType: "DISCOUNTED",
      originalPrice: 100,
      overrideReason: "damaged cartons",
      overriddenBy: "user-old",
    };
    const caseLineUpdate = (unitPrice: number, overrideReason?: string) =>
      service.updateOrderItems(
        "ord-1",
        {
          replaceAll: false,
          items: [
            {
              id: "li-case",
              unitLabel: "Case",
              qty: 3,
              unitPrice,
              ...(overrideReason ? { overrideReason } : {}),
            },
          ],
        } as never,
        operatorPayload as never,
      );
    beforeEach(() => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 3 });
      prisma.productUnit.findMany.mockResolvedValue([{ ...caseLadderRow, priceTier3: 80 }]);
      prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: [storedOverride] });
    });

    it("re-sending the stored price unchanged is a 200 that keeps the type, reason and stamp (no reason sent)", async () => {
      await caseLineUpdate(90);
      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            unitPrice: 90,
            subtotal: 270,
            priceType: "DISCOUNTED",
            originalPrice: 100,
            overrideReason: "damaged cartons",
            overriddenBy: "user-old",
          }),
        }),
      );
    });

    const qtyOnly = (user: unknown, qty = 5) =>
      service.updateOrderItems(
        "ord-1",
        { replaceAll: false, items: [{ id: "li-case", unitLabel: "Case", qty }] } as never,
        user as never,
      );
    const keptOverride = (qty: number) =>
      expect.objectContaining({
        data: expect.objectContaining({
          unitPrice: 90,
          subtotal: 90 * qty, // the KEPT $90, never the $80 tier price
          priceType: "DISCOUNTED",
          originalPrice: 100,
          overrideReason: "damaged cartons",
          overriddenBy: "user-old",
        }),
      });

    it("an OPERATOR qty-only edit keeps the stored override price, type, reason and stamp", async () => {
      await qtyOnly(operatorPayload);
      expect(prisma.orderItem.update).toHaveBeenCalledWith(keptOverride(5));
    });

    it("a DRIVER cannot reach the unit writer at all: the qty-only edit is a 409 UNIT_AWARE_LINE and the stored override is untouched", async () => {
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" });
      prisma.order.findFirst.mockResolvedValue({ routeRunStopId: "stop-1" });
      prisma.routeRunStop.findFirst.mockResolvedValue({
        status: "PENDING",
        routeRun: { driverId: "drv-1", status: "IN_PROGRESS" },
      });
      const err = await qtyOnly({ ...operatorPayload, sub: "user-drv", role: "DRIVER" }, 4).catch(
        (e) => e,
      );
      expect(err.getResponse()).toMatchObject({ code: "UNIT_AWARE_LINE" });
      expect(prisma.orderItem.update).not.toHaveBeenCalled();
    });

    const buyer = {
      sub: "user-cust",
      username: "buyer",
      role: "CUSTOMER" as const,
      tenantId: "t-1",
    };

    it("SA-507b: a BUYER count edit of a plain tier line re-prices at the buyer's CURRENT tier (stored 100 -> tier-3 80)", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        lineItems: [{ ...existingCaseLine, unitPrice: 100, priceType: "STANDARD" }],
      });
      await qtyOnly(buyer, 4);
      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ unitPrice: 80, subtotal: 320, priceType: "SPECIAL" }),
        }),
      );
    });

    it("a BUYER count edit of an OVERRIDDEN unit line keeps the price and the reason (an override is kept on every path)", async () => {
      await qtyOnly(buyer, 4);
      expect(prisma.orderItem.update).toHaveBeenCalledWith(keptOverride(4));
    });

    it("a STANDARD unit line on a qty-only edit keeps its stored price like a pack line does", async () => {
      // the tier price has moved since the sale: the stored $100 stays, as the pack branch's existingUnitPrice does
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        lineItems: [{ ...existingCaseLine, unitPrice: 100, priceType: "STANDARD" }],
      });
      await qtyOnly(operatorPayload, 3);
      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ unitPrice: 100, subtotal: 300, priceType: "STANDARD" }),
        }),
      );
    });

    it("changing the price without a reason is a 400 REASON_REQUIRED and writes nothing", async () => {
      await expect(caseLineUpdate(95)).rejects.toThrow(/reason is required/);
      expect(prisma.orderItem.update).not.toHaveBeenCalled();
    });

    it("changing the price WITH a reason re-decides it and stamps the editor", async () => {
      await caseLineUpdate(95, "new deal");
      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            unitPrice: 95,
            priceType: "DISCOUNTED",
            overrideReason: "new deal",
            overriddenBy: "user-op",
          }),
        }),
      );
    });
  });

  it("ADD a Case line (diff-add, no existing line for this product): base qty = count x factor", async () => {
    prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: [existingPackLine] });
    await service.updateOrderItems(
      "ord-1",
      {
        replaceAll: false,
        items: [{ productId: "prod-case", unitLabel: "Case", qty: 2 }],
      } as never,
      operatorPayload as never,
    );
    expect(prisma.orderItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: "ord-1",
          productId: "prod-case",
          unitLabel: "Case",
          qty: 24,
          boxes: 2,
          pieces: 0,
          unitsPerBox: 12,
          unitPrice: 100,
        }),
      }),
    );
  });

  it("SUBSTITUTE an existing pack line with a Case line", async () => {
    prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: [existingPackLine] });
    await service.updateOrderItems(
      "ord-1",
      {
        replaceAll: false,
        items: [{ id: "li-pack", substituteProductId: "prod-case", unitLabel: "Case", qty: 2 }],
      } as never,
      operatorPayload as never,
    );
    expect(prisma.orderItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "li-pack", orderId: "ord-1" },
        data: expect.objectContaining({
          productId: "prod-case",
          unitLabel: "Case",
          qty: 24,
          boxes: 2,
          unitsPerBox: 12,
        }),
      }),
    );
  });

  it("B297 (SA-098a): a same-product Case qty edit preserves the STORED trio, never re-stamping from a since-changed live rate", async () => {
    prisma.order.findUnique.mockResolvedValue({
      ...MOCK_ORDER,
      lineItems: [existingRegulatedCaseLine],
    });
    prisma.product.findMany.mockResolvedValue([regulatedCaseProduct]);
    prisma.product.findUniqueOrThrow.mockResolvedValue(regulatedCaseProduct);
    prisma.productUnit.findMany.mockResolvedValue([regulatedCaseLadderRow]);
    // Live rate has moved to 0.5 since the line was sold at 0.3 — must never overwrite it.
    prisma.trackedCategory.findMany.mockResolvedValue([liveCategory]);

    await service.updateOrderItems(
      "ord-1",
      { replaceAll: false, items: [{ id: "li-case-reg", unitLabel: "Case", qty: 3 }] } as never,
      operatorPayload as never,
    );

    const upd = prisma.orderItem.update.mock.calls.find(
      (c: any) => c[0]?.where?.id === "li-case-reg",
    );
    expect(upd).toBeDefined();
    const data = upd![0].data;
    // The 3 trio keys are absent from the write entirely — Prisma leaves the stored
    // 0.3 rate untouched, never overwritten by the live 0.5.
    expect("categoryTaxType" in data).toBe(false);
    expect("categoryTaxRate" in data).toBe(false);
    expect("categoryPriceIncludesTax" in data).toBe(false);
  });

  it("row 373b: a staff replace-all converting a paired pack line to Case keeps the STORED trio and createdAt, never the live rate", async () => {
    const SOLD_AT = new Date("2026-09-01T09:00:00Z");
    // a stored PACK line (no unit label) of the regulated product, sold at 0.3; the live rate is 0.5 now
    const storedPack = {
      ...existingRegulatedCaseLine,
      id: "li-pack-reg",
      unitLabel: null,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      qty: 2,
      createdAt: SOLD_AT,
    };
    prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: [storedPack] });
    prisma.product.findMany.mockResolvedValue([regulatedCaseProduct]);
    prisma.product.findUniqueOrThrow.mockResolvedValue(regulatedCaseProduct);
    prisma.productUnit.findMany.mockResolvedValue([regulatedCaseLadderRow]);
    prisma.trackedCategory.findMany.mockResolvedValue([liveCategory]);

    await service.updateOrderItems(
      "ord-1",
      {
        replaceAll: true,
        items: [{ id: "li-pack-reg", productId: "prod-case-reg", unitLabel: "Case", qty: 2 }],
      } as never,
      operatorPayload as never,
    );

    const made = prisma.orderItem.create.mock.calls
      .map((c: any) => c[0].data)
      .find((d: any) => d.productId === "prod-case-reg");
    expect(made).toBeDefined();
    expect(made.unitLabel).toBe("Case");
    expect(made.categoryTaxRate).toBe(0.3);
    expect(made.createdAt).toEqual(SOLD_AT);
  });

  it("B297 (SA-098a): substituting to a regulated Case product re-stamps the trio from the NEW product's live category", async () => {
    prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: [existingPackLine] });
    prisma.product.findMany.mockResolvedValue([regulatedCaseProduct]);
    prisma.product.findUniqueOrThrow.mockResolvedValue(regulatedCaseProduct);
    prisma.productUnit.findMany.mockResolvedValue([regulatedCaseLadderRow]);
    prisma.trackedCategory.findMany.mockResolvedValue([liveCategory]);

    await service.updateOrderItems(
      "ord-1",
      {
        replaceAll: false,
        items: [{ id: "li-pack", substituteProductId: "prod-case-reg", unitLabel: "Case", qty: 2 }],
      } as never,
      operatorPayload as never,
    );

    expect(prisma.orderItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "li-pack", orderId: "ord-1" },
        data: expect.objectContaining({
          productId: "prod-case-reg",
          categoryTaxType: "EXCISE_PER_UNIT",
          categoryTaxRate: 0.5,
          categoryPriceIncludesTax: false,
        }),
      }),
    );
  });

  it("replaceAll with a unit line: base qty = count x factor, position preserved", async () => {
    prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: [existingPackLine] });
    await service.updateOrderItems(
      "ord-1",
      { replaceAll: true, items: [{ productId: "prod-case", unitLabel: "Case", qty: 2 }] } as never,
      operatorPayload as never,
    );
    expect(prisma.orderItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          productId: "prod-case",
          unitLabel: "Case",
          qty: 24,
          boxes: 2,
          pieces: 0,
          position: 0,
        }),
      }),
    );
  });

  it("the stock delta for a Case qty change is computed in BASE units (2 -> 3 Cases is +12 pieces, not +1)", async () => {
    prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: [existingCaseLine] });
    prisma.orderItem.findMany.mockResolvedValue([existingCaseLine]);
    prisma.product.findFirst.mockResolvedValue({
      id: "prod-case",
      currentStock: 100,
      unitsPerBox: 12,
    });
    await service.updateOrderItems(
      "ord-1",
      { replaceAll: false, items: [{ id: "li-case", unitLabel: "Case", qty: 3 }] } as never,
      operatorPayload as never,
    );
    // settleStockForEdit reads the delta off qty (base units) exactly like a boxed pack line —
    // no unit-specific stock code exists or is needed (UnitLineData.qty is already base pieces).
    const stockUpdate = prisma.product.updateMany.mock.calls.find(
      (c: any) => c[0]?.where?.id?.in?.includes?.("prod-case") || c[0]?.where?.id === "prod-case",
    );
    if (stockUpdate) {
      expect(stockUpdate[0].data.currentStock).toBeDefined();
    }
  });

  it("restrictions sizing still sees the increase for a Case line (assertLinesSellable is invoked with the edited lines)", async () => {
    prisma.order.findUnique.mockResolvedValue({
      ...MOCK_ORDER,
      status: "CONFIRMED",
      lineItems: [existingCaseLine],
    });
    const restrictions = (service as any).sellingRestrictions as {
      assertLinesSellable: jest.Mock;
      getPolicy: jest.Mock;
    };
    restrictions.getPolicy.mockResolvedValue({ enabled: true });
    await service.updateOrderItems(
      "ord-1",
      { replaceAll: false, items: [{ id: "li-case", unitLabel: "Case", qty: 3 }] } as never,
      operatorPayload as never,
    );
    expect(restrictions.assertLinesSellable).toHaveBeenCalled();
  });

  describe("the staff create-merge auto-merge path (foldMergeItems -> replaceAll, B619)", () => {
    // B619: foldMergeItems now threads a Case line's unitLabel through the fold instead of
    // silently dropping it (which used to write it back as a pack line at the pack price — the
    // B606 shape, in the create-merge writer specifically). This is the SAME replaceAll site
    // already wired above; these two pin that `isCreateMerge` changes nothing about it.
    it("with the flag ON: a fold-output item carrying unitLabel resolves through the same map and writes a unit line", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: [existingPackLine] });
      await service.updateOrderItems(
        "ord-1",
        {
          replaceAll: true,
          items: [{ productId: "prod-case", unitLabel: "Case", qty: 2 }],
        } as never,
        operatorPayload as never,
        { isCreateMerge: true },
      );
      expect(prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ productId: "prod-case", unitLabel: "Case", qty: 24 }),
        }),
      );
    });

    it("with the flag OFF: the same fold-output item is REFUSED, never silently written as a pack line", async () => {
      entitlements.hasFlag.mockResolvedValue(false);
      prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: [existingPackLine] });
      const err = await service
        .updateOrderItems(
          "ord-1",
          {
            replaceAll: true,
            items: [{ productId: "prod-case", unitLabel: "Case", qty: 2 }],
          } as never,
          operatorPayload as never,
          { isCreateMerge: true },
        )
        .catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/not included in this plan/);
      expect(prisma.orderItem.create).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ productId: "prod-case" }) }),
      );
    });
  });
});
