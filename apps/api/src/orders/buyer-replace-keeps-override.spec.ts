/**
 * Row 497 (SA ruling, option B): the buyer's FULL-LIST replace of PACK lines (updateOrderItems, CUSTOMER branch)
 * used to re-price every line at the buyer's current tier, so an operator override on a line the buyer left
 * alone was lost. Now an UNCHANGED line (same product, same unit, paired to its stored line) that carries an
 * OVERRIDE (DISCOUNTED / MANUAL, or SPECIAL with a stored reason) keeps unitPrice, priceType, originalPrice,
 * overrideReason and overriddenBy; the subtotal is recomputed from the kept price. A PLAIN tier line
 * (STANDARD, or SPECIAL without a reason) still re-prices at the current tier (SA-507b, as the unit buyer diff
 * does), and a new line or a changed product prices fresh at the tier.
 * Row 496: the same DTO's overrideReason is capped, trimmed and refused when formula-led.
 * Harness: copied from orders.update-items-guards.spec.ts (mocked PrismaService).
 */
jest.mock("./driver-edit-access", () => ({ assertDriverMayEditOrder: jest.fn() }));
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

import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UpdateOrderItemsDto } from "./dto/update-order-items.dto";
import { CreateOrderDto } from "./dto/create-order.dto";
import { ForbiddenException } from "@nestjs/common";
import { assertSafeOverrideReasons } from "./buyer-replace-keep";

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
  tenantId: "test-tenant",
  tenantSlug: "test",
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

describe("OrdersService.updateOrderItems: a buyer's full-list replace keeps unchanged overrides (row 497)", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let promotions: { activeForCatalog: jest.Mock };

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
            followPartialPrices: jest.fn().mockResolvedValue({ issuedPartialsUnchanged: [] }),
            projectEditedInvoiceTotals: jest.fn().mockResolvedValue([]),
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
    promotions = module.get(PromotionsService);
  });

  // Stored pack lines of a boxed product (upb 12, list/tier-1 box price 12): 1 box + 6 pieces = 18 pieces.
  const line = (over: Record<string, unknown>) => ({
    id: "li-1",
    orderId: "ord-1",
    productId: "prod-a",
    qty: 18,
    boxes: 1,
    pieces: 6,
    unitsPerBox: 12,
    unitLabel: null,
    unitPrice: 12,
    subtotal: 18,
    status: "PENDING",
    priceType: "STANDARD",
    originalPrice: null,
    overrideReason: null,
    overriddenBy: null,
    createdAt: new Date("2026-01-01"),
    position: 0,
    ...over,
  });
  const product = (id: string) => ({
    id,
    pricePerUnit: 12,
    unitsPerBox: 12,
    category: null,
    trackedCategoryId: null,
    trackedSubcategoryId: null,
  });
  const OVERRIDE = {
    unitPrice: 8,
    priceType: "DISCOUNTED",
    originalPrice: 12,
    overrideReason: "damaged cartons",
    overriddenBy: "user-op",
  };

  function prime(lines: Array<Record<string, unknown>>, products?: Array<Record<string, unknown>>) {
    prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: lines });
    prisma.orderItem.findMany.mockResolvedValue(lines);
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    prisma.product.findMany.mockResolvedValue(products ?? [product("prod-a"), product("prod-b")]);
  }
  const replace = (items: Array<Record<string, unknown>>) =>
    service.updateOrderItems("ord-1", { items, namesLines: true } as never, customerPayload, {
      buyerLineIds: true,
    });
  // the buyer cart-merge fold names a stored line by `sourceLineId` (never by orderItemId), with no buyerLineIds
  const fold = (items: Array<Record<string, unknown>>) =>
    service.updateOrderItems("ord-1", { items, replaceAll: true } as never, customerPayload);
  const created = () => prisma.orderItem.create.mock.calls.map((c: any) => c[0].data);

  it("an overridden line re-sent unchanged keeps price, type, original price, reason and stamp", async () => {
    prime([line(OVERRIDE)]);
    await replace([{ productId: "prod-a", qty: 18, orderItemId: "li-1" }]);
    // hand: 1 box x $8 + 6 pieces x ($8 / 12) = $12.00
    expect(created()).toHaveLength(1);
    expect(created()[0]).toMatchObject({ ...OVERRIDE, subtotal: 12 });
  });

  it("an overridden line with a CHANGED qty keeps the price and recomputes the subtotal", async () => {
    prime([line(OVERRIDE)]);
    await replace([{ productId: "prod-a", qty: 30, orderItemId: "li-1" }]);
    // hand: 30 pieces = 2 boxes + 6 pieces: 2 x $8 + 6 x ($8 / 12) = $20.00 (tier price $12 would be $30.00)
    expect(created()[0]).toMatchObject({ ...OVERRIDE, qty: 30, boxes: 2, pieces: 6, subtotal: 20 });
  });

  it("a MANUAL override and a SPECIAL line with a reason are kept the same way", async () => {
    prime([
      line({
        id: "li-m",
        unitPrice: 15,
        priceType: "MANUAL",
        originalPrice: 12,
        overrideReason: "upsell",
        overriddenBy: "user-op",
      }),
      line({
        id: "li-s",
        productId: "prod-b",
        unitPrice: 9,
        priceType: "SPECIAL",
        originalPrice: 12,
        overrideReason: "contract",
        overriddenBy: "user-op",
      }),
    ]);
    await replace([
      { productId: "prod-a", qty: 18, orderItemId: "li-m" },
      { productId: "prod-b", qty: 18, orderItemId: "li-s" },
    ]);
    expect(created()[0]).toMatchObject({
      unitPrice: 15,
      priceType: "MANUAL",
      overrideReason: "upsell",
      overriddenBy: "user-op",
    });
    expect(created()[1]).toMatchObject({
      unitPrice: 9,
      priceType: "SPECIAL",
      overrideReason: "contract",
      overriddenBy: "user-op",
    });
  });

  it("a PLAIN tier line (STANDARD, or SPECIAL with no reason) re-prices at the current tier (SA-507b)", async () => {
    prime([
      line({ id: "li-p", unitPrice: 11, priceType: "STANDARD" }),
      line({
        id: "li-q",
        productId: "prod-b",
        unitPrice: 9,
        priceType: "SPECIAL",
        originalPrice: 12,
      }),
    ]);
    await replace([
      { productId: "prod-a", qty: 18, orderItemId: "li-p" },
      { productId: "prod-b", qty: 18, orderItemId: "li-q" },
    ]);
    // hand: tier 1 = the $12 box price: 12 + 6 x (12 / 12) = $18.00 each
    expect(created()[0]).toMatchObject({ unitPrice: 12, priceType: "STANDARD", subtotal: 18 });
    expect(created()[1]).toMatchObject({ unitPrice: 12, priceType: "STANDARD", subtotal: 18 });
  });

  it("a changed product prices fresh at the tier (the override belongs to the dropped line)", async () => {
    prime([line(OVERRIDE)]);
    await replace([{ productId: "prod-b", qty: 18 }]);
    expect(created()).toHaveLength(1);
    expect(created()[0]).toMatchObject({
      productId: "prod-b",
      unitPrice: 12,
      priceType: "STANDARD",
    });
    expect(created()[0].overrideReason ?? null).toBeNull();
    expect(created()[0].overriddenBy ?? null).toBeNull();
  });

  it("a NEW line beside a kept override prices at the tier and carries no stamp", async () => {
    prime([line(OVERRIDE)]);
    await replace([
      { productId: "prod-a", qty: 18, orderItemId: "li-1" },
      { productId: "prod-b", qty: 12 },
    ]);
    expect(created()[0]).toMatchObject(OVERRIDE);
    expect(created()[1]).toMatchObject({
      productId: "prod-b",
      unitPrice: 12,
      priceType: "STANDARD",
    });
    expect(created()[1].overriddenBy ?? null).toBeNull();
  });

  it("a staff edit with a formula-led overrideReason is refused (400, TEXT_CELL_FORMULA_LEAD) before any write", async () => {
    prime([line({})]);
    await expect(
      service.updateOrderItems(
        "ord-1",
        {
          items: [{ id: "li-1", action: "UPDATE", qty: 18, unitPrice: 8, overrideReason: "=1+1" }],
        } as never,
        {
          sub: "user-op",
          username: "op",
          role: "OPERATOR",
          status: "ACTIVE",
          forcePasswordChange: false,
        } as never,
      ),
    ).rejects.toMatchObject({ response: { code: "TEXT_CELL_FORMULA_LEAD" } });
    expect(prisma.orderItem.create).not.toHaveBeenCalled();
    expect(prisma.orderItem.update).not.toHaveBeenCalled();
  });

  it("MUST 1: the fold path (sourceLineId) keeps an override whose stored reason is '-'-led, and echoing it is not refused", async () => {
    prime([line({ ...OVERRIDE, overrideReason: "-5 courtesy", unitPrice: 8 })]);
    await fold([
      { productId: "prod-a", qty: 18, sourceLineId: "li-1", overrideReason: "-5 courtesy" },
    ]);
    expect(created()[0]).toMatchObject({
      ...OVERRIDE,
      overrideReason: "-5 courtesy",
      subtotal: 12,
    });
  });

  it("MUST 1: the buyer's items edit (orderItemId) echoing a '-'-led stored reason is not refused either", async () => {
    prime([line({ ...OVERRIDE, overrideReason: "-5 courtesy" })]);
    await replace([
      { productId: "prod-a", qty: 18, orderItemId: "li-1", overrideReason: "-5 courtesy" },
    ]);
    expect(created()[0]).toMatchObject({ overrideReason: "-5 courtesy", unitPrice: 8 });
  });

  it("MUST 2: a box-split override is NOT kept once the product's box size changed (12 -> 6): it prices fresh", async () => {
    // stored: 2 boxes of 12 (24 pieces) at the kept $8 box price. Live product: boxes of 6, so 24 pieces is 4 boxes.
    prime(
      [line({ ...OVERRIDE, qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12, subtotal: "16.00" })],
      [{ ...product("prod-a"), unitsPerBox: 6 }],
    );
    await replace([{ productId: "prod-a", qty: 24, orderItemId: "li-1" }]);
    // hand: tier 1 = $12 a box: 4 x $12 = $48.00 (keeping $8 would bill 4 x $8 = $32.00 for what was $16.00)
    expect(created()[0]).toMatchObject({
      boxes: 4,
      pieces: 0,
      unitPrice: 12,
      priceType: "STANDARD",
      subtotal: 48,
    });
    expect(created()[0].overriddenBy ?? null).toBeNull();
    expect(created()[0].overrideReason ?? null).toBeNull();
  });

  it("a LEGACY box-split row (boxes set, unitsPerBox null) holding an override prices fresh (fail closed)", async () => {
    // the box size it was sold at is unknown, so the kept $8 box price could be re-split at a different size
    prime([line({ ...OVERRIDE, unitsPerBox: null })]);
    await replace([{ productId: "prod-a", qty: 18, orderItemId: "li-1" }]);
    // hand: 1 box + 6 pieces at the tier $12 box price: 12 + 6 x (12 / 12) = $18.00
    expect(created()[0]).toMatchObject({ unitPrice: 12, priceType: "STANDARD", subtotal: 18 });
    expect(created()[0].overrideReason ?? null).toBeNull();
    expect(created()[0].overriddenBy ?? null).toBeNull();
  });

  it("a box-UNAWARE selling-unit override (boxes null, unitsPerBox null) is still kept", async () => {
    prime([
      line({
        ...OVERRIDE,
        qty: 2,
        boxes: null,
        pieces: null,
        unitsPerBox: null,
        subtotal: "16.00",
      }),
    ]);
    await replace([{ productId: "prod-a", qty: 2, orderItemId: "li-1" }]);
    expect(created()[0]).toMatchObject({ ...OVERRIDE, qty: 2, subtotal: 16 });
  });

  it("MUST 3: a kept override stays out of the split-promo group, so the plain line of the SAME product keeps its free units", async () => {
    // BUY 4 GET 1 (blocks of 5 whole units). Unboxed product at $10. L-old: an override line of 10 at $8 (older);
    // L-new: a plain tier line of 10.
    const bogo = {
      id: "promo-bogo",
      type: "BUY_N_GET_M",
      value: 1,
      minQty: 4,
      scope: "ALL",
      category: null,
      productIds: [],
    };
    promotions.activeForCatalog.mockResolvedValue([bogo]);
    const plainProduct = {
      id: "prod-c",
      pricePerUnit: 10,
      unitsPerBox: null,
      category: null,
      trackedCategoryId: null,
      trackedSubcategoryId: null,
    };
    const base = { productId: "prod-c", qty: 10, boxes: null, pieces: null, unitsPerBox: null };
    prime(
      [
        line({
          ...base,
          id: "L-old",
          unitPrice: 8,
          subtotal: "80.00",
          priceType: "DISCOUNTED",
          originalPrice: 10,
          overrideReason: "damaged",
          overriddenBy: "user-op",
          createdAt: new Date("2026-01-01"),
          position: 0,
        }),
        line({
          ...base,
          id: "L-new",
          unitPrice: 10,
          subtotal: "100.00",
          createdAt: new Date("2026-02-01"),
          position: 1,
        }),
      ],
      [plainProduct],
    );
    await replace([
      { productId: "prod-c", qty: 10, orderItemId: "L-old" },
      { productId: "prod-c", qty: 10, orderItemId: "L-new" },
    ]);
    const [kept, plain] = created();
    expect(kept).toMatchObject({ unitPrice: 8, priceType: "DISCOUNTED", subtotal: 80 });
    // hand: the plain line alone is 10 whole units: floor(10 / 5) x 1 = 2 free; 8 billed x $10 = $80.00. (With the
    // override in the group: 20 units -> 4 free, all allocated to the OLDER override line, the plain line gets 0.)
    expect(plain).toMatchObject({ priceType: "PROMO", promoFreeUnits: 2, subtotal: 80 });
  });

  it("two lines of the SAME product with different overrides each keep their own", async () => {
    prime([
      line({ ...OVERRIDE, id: "li-1", position: 0 }),
      line({
        id: "li-2",
        unitPrice: 15,
        subtotal: "22.50",
        priceType: "MANUAL",
        originalPrice: 12,
        overrideReason: "upsell",
        overriddenBy: "user-op2",
        createdAt: new Date("2026-02-01"),
        position: 1,
      }),
    ]);
    await replace([
      { productId: "prod-a", qty: 18, orderItemId: "li-1" },
      { productId: "prod-a", qty: 18, orderItemId: "li-2" },
    ]);
    expect(created()[0]).toMatchObject({
      unitPrice: 8,
      priceType: "DISCOUNTED",
      overrideReason: "damaged cartons",
      overriddenBy: "user-op",
    });
    expect(created()[1]).toMatchObject({
      unitPrice: 15,
      priceType: "MANUAL",
      overrideReason: "upsell",
      overriddenBy: "user-op2",
    });
  });

  it("the fold path keeps an override line the same way (sourceLineId, no orderItemId)", async () => {
    prime([line(OVERRIDE)]);
    await fold([{ productId: "prod-a", qty: 30, sourceLineId: "li-1" }]);
    expect(created()[0]).toMatchObject({ ...OVERRIDE, qty: 30, subtotal: 20 });
  });

  it("create(): a formula-led line reason is refused 400 before any read or write", async () => {
    await expect(
      service.create(
        { items: [{ productId: "p", qty: 1, overrideReason: "=1+1" }] } as never,
        {
          sub: "user-op",
          username: "op",
          role: "OPERATOR",
          status: "ACTIVE",
          forcePasswordChange: false,
        } as never,
      ),
    ).rejects.toMatchObject({ response: { code: "TEXT_CELL_FORMULA_LEAD" } });
  });
  it("MUST 4: a non-owner meets the 403 before any answer about the reason (never a 400)", async () => {
    prime([line(OVERRIDE)]);
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-OTHER", pricingTier: 1 });
    await expect(
      service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-1", qty: 18, overrideReason: "=1+1" }] } as never,
        customerPayload,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.orderItem.create).not.toHaveBeenCalled();
  });

  it("a stored line of ANOTHER unit is never kept as a pack price", async () => {
    prime([line({ ...OVERRIDE, unitLabel: "Case" })]);
    await expect(
      replace([{ productId: "prod-a", qty: 18, orderItemId: "li-1" }]),
    ).rejects.toBeDefined();
    expect(created().filter((d: any) => d.priceType === "DISCOUNTED")).toHaveLength(0);
  });
});

describe("updateOrderItems: a formula-led overrideReason is refused (row 496)", () => {
  // A second, minimal service build would repeat the whole provider list; the guard is a pure function over the
  // payload and the stored lines, so it is pinned directly and through the service entry below.
  it("assertSafeOverrideReasons refuses a formula-led reason a spreadsheet would run (400, TEXT_CELL_FORMULA_LEAD)", () => {
    expect(() =>
      assertSafeOverrideReasons(
        [{ id: "li-1", overrideReason: "=HYPERLINK(1)" }],
        [{ id: "li-1", overrideReason: null }],
      ),
    ).toThrow(/overrideReason/);
    expect(() =>
      assertSafeOverrideReasons([{ id: "li-1", overrideReason: "@SUM(A1)" }], []),
    ).toThrow();
  });
  it("MUST 1: finds the stored line by id, sourceLineId or orderItemId, and judges only a CHANGED reason", () => {
    const stored = [{ id: "li-1", overrideReason: "-old" }];
    for (const key of ["id", "sourceLineId", "orderItemId"]) {
      expect(() =>
        assertSafeOverrideReasons([{ [key]: "li-1", overrideReason: "-old" }], stored),
      ).not.toThrow();
      expect(() =>
        assertSafeOverrideReasons([{ [key]: "li-1", overrideReason: "-new" }], stored),
      ).toThrow();
    }
  });
  it("tolerates a non-string reason on the payload or the stored row", () => {
    expect(() =>
      assertSafeOverrideReasons(
        [{ id: "li-1", overrideReason: 5 as never }],
        [{ id: "li-1", overrideReason: 7 as never }],
      ),
    ).not.toThrow();
  });
  it("lets a clean reason, and an unchanged stored legacy value, through", () => {
    expect(() =>
      assertSafeOverrideReasons([{ id: "li-1", overrideReason: "damaged" }], []),
    ).not.toThrow();
    expect(() =>
      assertSafeOverrideReasons(
        [{ id: "li-1", overrideReason: "=old" }],
        [{ id: "li-1", overrideReason: "=old" }],
      ),
    ).not.toThrow();
  });
});

describe("UpdateOrderItemDto.overrideReason (row 496)", () => {
  const check = async (overrideReason: unknown) =>
    validate(plainToInstance(UpdateOrderItemsDto, { items: [{ id: "x", overrideReason }] }));

  it("refuses a 201-character reason", async () => {
    const errs = await check("a".repeat(201));
    expect(JSON.stringify(errs)).toContain("maxLength");
  });
  it("accepts 200 characters", async () => {
    expect(await check("a".repeat(200))).toHaveLength(0);
  });
  it("a whitespace-only reason becomes null (never a stored blank)", () => {
    const dto = plainToInstance(UpdateOrderItemsDto, {
      items: [{ id: "x", overrideReason: "   " }],
    });
    expect(dto.items[0].overrideReason).toBeNull();
  });
  it("create-order.dto.ts: the same cap and trim", async () => {
    const mk = (r: string) =>
      plainToInstance(CreateOrderDto, { items: [{ productId: "p", qty: 1, overrideReason: r }] });
    expect(mk("  why  ").items![0].overrideReason).toBe("why");
    expect(JSON.stringify(await validate(mk("a".repeat(201))))).toContain("maxLength");
  });
  it("trims the reason", () => {
    const dto = plainToInstance(UpdateOrderItemsDto, {
      items: [{ id: "x", overrideReason: "  damaged  " }],
    });
    expect(dto.items[0].overrideReason).toBe("damaged");
  });
});
