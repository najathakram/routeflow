/**
 * BUY_N_GET_M ("buy 5, get the 6th free") — WP2 order-engine regression specs.
 * Plan: .claude/pipeline/plans/2026-08-21-buy-n-get-m-promotion.md (WP2).
 *
 * The owner's exact words: "when you buy 5 of the same unit, you get the 6th one
 * free... if you buy 12, you get 2 free (11th and 12th unit). we don't give 35
 * per unit off. that's a mistake!!!" — the previous "fix" was FIXED $35-off-ALL,
 * which priced 40% of the live catalog at $0.00.
 *
 * These specs pin:
 *  1. the owner's exact quantity table via a real OrdersService.create() buyer order,
 *  2. that loose pieces never count toward the threshold — selling units only,
 *  3. exactness — the SUBTOTAL is reduced by whole free units, never a rounded
 *     net-unit-price (35 × 5/6 = 29.1667-style drift is impossible),
 *  4. BUY_N_GET_M vs an existing PERCENT promo stays correct in both directions,
 *     and the PERCENT-wins shape is bit-for-bit the pre-BOGO shape (regression pin),
 *  5. invoice derivation copies the order line's exact subtotal verbatim
 *     (#181 / the #288 resync path) — never a `qty * unitPrice` recompute.
 */

// Mirrors invoices.service.spec.ts's guard: prevents Jest from traversing
// ESM-only dependencies (@react-pdf/renderer via invoice-pdf.service) pulled in
// transitively by importing the REAL InvoicesService class below — needed for
// the invoice-derivation pin, since its `buildInvoiceItemData` is otherwise
// untestable from outside the module (it's private, correctly so).
jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));
// Mirrors orders.service.spec.ts's guard: NotificationsService imports
// expo-server-sdk (ESM-only), pulled in transitively by the real OrdersService.
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({
    sendToCustomer: jest.fn().mockResolvedValue(undefined),
    sendToDriver: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bull";
import { Prisma } from "@prisma/client";
import { OrdersService } from "./orders.service";
import { InvoicesService } from "../invoices/invoices.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NotificationsService } from "../notifications/notifications.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { SystemConfigService } from "../system-config/system-config.service";
import { InventoryService } from "../inventory/inventory.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { PromotionsService } from "../promotions/promotions.service";
import { MessagingService } from "../messaging/messaging.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EntitlementsService } from "../billing/entitlements.service";

const customerPayload = {
  sub: "user-cust",
  username: "customer1",
  role: "CUSTOMER" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

const operatorPayload = {
  sub: "user-op",
  username: "operator1",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

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
  customer: { businessName: "Test Business" },
};

// Plain (non-boxed) $35 product — the owner's mental model needs no box math:
// the "unit" IS the selling unit. unitsPerBox left unset (non-boxed).
const PLAIN_PRODUCT = { id: "prod-plain", name: "Widget", pricePerUnit: 35, unit: "each" };

// A boxed product with a deliberately large box size (100/case) so a handful of
// loose pieces (well under 100) can never roll into a whole extra box via
// normalizeBoxesPieces — isolates "pieces never count toward N" from ordinary
// box-rollover arithmetic.
const BOXED_PRODUCT = {
  id: "prod-box",
  name: "Case of widgets",
  pricePerUnit: 35,
  unit: "case",
  unitsPerBox: 100,
};

/** N=5, M=1 — "buy 5, get the 6th free" (the owner's actual promo). */
const BOGO_5_1 = {
  id: "promo-bogo",
  type: "BUY_N_GET_M" as const,
  value: 1,
  minQty: 5,
  scope: "ALL" as const,
  category: null as string | null,
  productIds: [] as string[],
};

describe("OrdersService — BUY_N_GET_M (BOGO)", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
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
        {
          provide: NotificationsService,
          useValue: {
            sendToCustomer: jest.fn().mockResolvedValue(undefined),
            sendToDriver: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: InvoicesService,
          useValue: {
            createInvoiceFromOrder: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
            reconcileOrderDraftInvoice: jest.fn().mockResolvedValue({ id: "inv-1" }),
            resyncOrderInvoicesForEdit: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
            revertLinkedInvoicesForOrderEdit: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: SystemConfigService,
          useValue: {
            get: jest.fn().mockResolvedValue("0"), // 0% tax rate — clean money assertions
            set: jest.fn().mockResolvedValue(undefined),
            getAll: jest.fn().mockResolvedValue({}),
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
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
          provide: EntitlementsService,
          useValue: { hasFlag: jest.fn().mockResolvedValue(true) },
        },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
  });

  /** Buyer-path mocks: customer on tier 1, no per-product override, one promo pool. */
  function seedBuyerMocks(product: Record<string, unknown>, promos: unknown[]) {
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    prisma.customer.findUnique.mockResolvedValue({ pricingTier: 1 });
    prisma.customerPrice.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([product]);
    prisma.order.create.mockResolvedValue(MOCK_ORDER);
    ((service as any).promotionsService.activeForCatalog as jest.Mock).mockResolvedValue(promos);
  }

  /** The single line item passed to the (mocked) prisma.order.create call. */
  function createdLine() {
    return prisma.order.create.mock.calls.at(-1)?.[0].data.lineItems.create[0];
  }

  // ── Owner's exact quantity table ─────────────────────────────────────────
  // "if you buy 12, you get 2 free (11th and 12th unit)."
  describe("the owner's exact quantity table (N=5, M=1)", () => {
    it.each([
      [5, 0],
      [6, 1],
      [11, 1],
      [12, 2],
      [18, 3],
    ])("%i units -> %i free", async (qty, expectedFree) => {
      seedBuyerMocks(PLAIN_PRODUCT, [BOGO_5_1]);

      await service.create({ items: [{ productId: "prod-plain", qty }] }, customerPayload);

      const line = createdLine();
      expect(line.promoFreeUnits).toBe(expectedFree > 0 ? expectedFree : null);
      // Exact: (qty - free) * $35 — never qty * $35 and never a rounded net price.
      expect(line.subtotal).toBe((qty - expectedFree) * 35);
    });
  });

  // ── Pieces never count toward N ───────────────────────────────────────────
  it("pieces never count toward N — 5 whole boxes + 40 loose pieces earns 0 free", async () => {
    seedBuyerMocks(BOXED_PRODUCT, [BOGO_5_1]);

    await service.create(
      { items: [{ productId: "prod-box", boxes: 5, pieces: 40 }] },
      customerPayload,
    );

    const line = createdLine();
    expect(line.boxes).toBe(5); // the 40 loose pieces did NOT roll into a 6th box
    expect(line.pieces).toBe(40);
    expect(line.promoFreeUnits).toBeNull();
    // No free units earned: plain box-equivalent proration, $35 * (5 + 40/100).
    expect(line.subtotal).toBeCloseTo(35 * 5.4, 2);
  });

  it("a 6th WHOLE box (not 40 loose pieces) is what earns the free unit", async () => {
    seedBuyerMocks(BOXED_PRODUCT, [BOGO_5_1]);

    await service.create(
      { items: [{ productId: "prod-box", boxes: 6, pieces: 0 }] },
      customerPayload,
    );

    const line = createdLine();
    expect(line.promoFreeUnits).toBe(1);
    expect(line.subtotal).toBe(35 * 5); // 6 boxes - 1 free = 5 billed boxes, exact
  });

  // ── Exactness: never a rounded net-unit-price ─────────────────────────────
  it("12 units @ $35 with 2 free totals exactly $350.00 (never a 29.17-style drift)", async () => {
    seedBuyerMocks(PLAIN_PRODUCT, [BOGO_5_1]);

    await service.create({ items: [{ productId: "prod-plain", qty: 12 }] }, customerPayload);

    const line = createdLine();
    expect(line.unitPrice).toBe(35); // base price, unchanged — never a derived net price
    expect(line.originalPrice).toBeNull();
    expect(line.priceType).toBe("PROMO");
    expect(line.promoFreeUnits).toBe(2);
    expect(line.subtotal).toBe(350);
    // The wrong formula this feature replaces: a $35 * 5/6 = $29.17 net-unit-price line.
    expect(line.subtotal).not.toBeCloseTo(12 * 29.17, 2);
  });

  // ── Best-of vs an existing PERCENT promo (both directions) ────────────────
  describe("best-of: BUY_N_GET_M vs an active PERCENT promo", () => {
    const PERCENT_5 = {
      id: "promo-percent",
      type: "PERCENT" as const,
      value: 5,
      minQty: null as number | null,
      scope: "ALL" as const,
      category: null as string | null,
      productIds: [] as string[],
    };
    const PERCENT_50 = { ...PERCENT_5, id: "promo-percent-big", value: 50 };

    it("BOGO wins when its saving is larger (6 units, 5% PERCENT vs BOGO)", async () => {
      seedBuyerMocks(PLAIN_PRODUCT, [PERCENT_5, BOGO_5_1]);

      await service.create({ items: [{ productId: "prod-plain", qty: 6 }] }, customerPayload);

      const line = createdLine();
      // BOGO saves 1 * $35 = $35; PERCENT saves (35-33.25)*6 = $10.50 — BOGO wins.
      expect(line.priceType).toBe("PROMO");
      expect(line.unitPrice).toBe(35);
      expect(line.originalPrice).toBeNull();
      expect(line.promoFreeUnits).toBe(1);
      expect(line.subtotal).toBe(175); // 5 billed units * $35
    });

    it("PERCENT wins when its saving is larger (existing behavior stays bit-for-bit unchanged)", async () => {
      seedBuyerMocks(PLAIN_PRODUCT, [PERCENT_50, BOGO_5_1]);

      await service.create({ items: [{ productId: "prod-plain", qty: 6 }] }, customerPayload);

      const line = createdLine();
      // PERCENT saves (35-17.5)*6 = $105; BOGO only saves 1*$35 = $35 — PERCENT
      // wins, and its shape is EXACTLY the pre-BOGO PERCENT shape (regression pin
      // — see the pre-existing "P5-04" test in orders.service.spec.ts).
      expect(line.priceType).toBe("PROMO");
      expect(line.unitPrice).toBe(17.5);
      expect(line.originalPrice).toBe(35);
      expect(line.promoFreeUnits).toBeNull();
      expect(line.subtotal).toBe(105); // 6 * $17.50
    });
  });

  // ── A malformed rule never crashes order pricing ──────────────────────────
  it("a malformed BUY_N_GET_M rule (non-integer minQty) is ignored, never applied or crashed", async () => {
    // The DTO/service guard (promotions.service.ts validateRule) rejects this at
    // creation time — this covers a legacy/corrupted row reaching pricing anyway.
    seedBuyerMocks(PLAIN_PRODUCT, [{ ...BOGO_5_1, minQty: 5.5 }]);

    await service.create({ items: [{ productId: "prod-plain", qty: 12 }] }, customerPayload);

    const line = createdLine();
    expect(line.priceType).toBe("STANDARD");
    expect(line.promoFreeUnits).toBeNull();
    expect(line.subtotal).toBe(12 * 35);
  });

  // ── Re-quantified lines re-derive their free units ────────────────────────
  // Free units are a function of the QUANTITY, so every path that changes a
  // line's qty while KEEPING its stored (agreed) price must re-derive them.
  // Re-using the sale-time snapshot verbatim is wrong in both directions.
  describe("a re-quantified line re-derives its free units", () => {
    /** A box-split BOGO line: `qty` is PIECES, `boxes` the whole selling units. */
    const bogoBoxLine = (
      id: string,
      orderId: string,
      boxes: number,
      promoFreeUnits: number | null,
      priceType: "PROMO" | "STANDARD" | "MANUAL" = "PROMO",
    ) => ({
      id,
      orderId,
      productId: "prod-box",
      name: null,
      qty: boxes * 100,
      boxes,
      pieces: 0,
      unitsPerBox: 100,
      unitPrice: 35,
      subtotal: (boxes - (promoFreeUnits ?? 0)) * 35,
      status: "PENDING",
      priceType,
      originalPrice: null,
      overrideReason: null,
      overriddenBy: null,
      promoFreeUnits,
      trackedCategoryId: null,
      deliveredQty: 0,
      invoicedQty: 0,
      notes: null,
    });

    function seedMergeMocks(promos: unknown[]) {
      prisma.order.findMany.mockResolvedValue([
        {
          id: "w1",
          customerId: "cust-1",
          status: "PENDING",
          lineItems: [bogoBoxLine("wl1", "w1", 12, 2)],
        },
        {
          id: "l1",
          customerId: "cust-1",
          status: "PENDING",
          lineItems: [bogoBoxLine("ll1", "l1", 6, 1)],
        },
      ]);
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-box", unitsPerBox: 100, category: null },
      ]);
      ((service as any).promotionsService.activeForCatalog as jest.Mock).mockResolvedValue(promos);
    }

    it("auto-merging 12 + 6 boxes bills 15 of 18 ($525) and stores 3 free", async () => {
      seedMergeMocks([BOGO_5_1]);

      await service.mergeAllPendingForCustomer("cust-1");

      const data = prisma.orderItem.update.mock.calls[0][0].data;
      expect(data.boxes).toBe(18);
      // 18 units earn floor(18/6) * 1 = 3 free — NOT the winner's stale 2, and
      // never 18 at full price ($630) with a contradicting promoFreeUnits: 2.
      expect(data.promoFreeUnits).toBe(3);
      expect(data.subtotal).toBe(15 * 35);
      expect(data.subtotal).not.toBe(18 * 35);
    });

    it("a merge keeps the earned rate when the promo has since ended", async () => {
      seedMergeMocks([]); // promo deactivated after the orders were placed

      await service.mergeAllPendingForCustomer("cust-1");

      const data = prisma.orderItem.update.mock.calls[0][0].data;
      // 2 + 1 free earned across 18 units — rescaled, never revoked (full price)
      // and never left stale against a full-price subtotal.
      expect(data.promoFreeUnits).toBe(3);
      expect(data.subtotal).toBe(15 * 35);
    });

    /**
     * Two buyer carts of 3 boxes each — NEITHER earned a free unit on its own
     * (3 < N + M), so no contribution carries a snapshot.
     */
    function seedSplitCartMocks(
      promos: unknown[],
      winnerPriceType: "PROMO" | "STANDARD" | "MANUAL" = "STANDARD",
    ) {
      prisma.order.findMany.mockResolvedValue([
        {
          id: "w1",
          customerId: "cust-1",
          status: "PENDING",
          lineItems: [bogoBoxLine("wl1", "w1", 3, null, winnerPriceType)],
        },
        {
          id: "l1",
          customerId: "cust-1",
          status: "PENDING",
          lineItems: [bogoBoxLine("ll1", "l1", 3, null, "STANDARD")],
        },
      ]);
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-box", unitsPerBox: 100, category: null },
      ]);
      ((service as any).promotionsService.activeForCatalog as jest.Mock).mockResolvedValue(promos);
    }

    it("a buyer's split carts (3 + 3 boxes) earn the free unit the merged 6 qualify for", async () => {
      seedSplitCartMocks([BOGO_5_1]);

      await service.mergeAllPendingForCustomer("cust-1", { buyerInitiated: true });

      const data = prisma.orderItem.update.mock.calls[0][0].data;
      expect(data.boxes).toBe(6);
      // The same 6 boxes in ONE cart earn 1 free — splitting the order across two
      // carts must not silently cost the buyer the promo the merge qualifies for.
      expect(data.promoFreeUnits).toBe(1);
      expect(data.subtotal).toBe(5 * 35);
      expect(data.subtotal).not.toBe(6 * 35);
    });

    it("the hourly sweep never grants free units the lines never had", async () => {
      seedSplitCartMocks([BOGO_5_1]);

      await service.mergeAllPendingForCustomer("cust-1"); // cron / staff default

      const data = prisma.orderItem.update.mock.calls[0][0].data;
      expect(data.boxes).toBe(6);
      // Not the buyer's own merge — the column stays untouched and both boxes bill.
      expect(data.promoFreeUnits).toBeUndefined();
      expect(data.subtotal).toBe(6 * 35);
    });

    it("an operator-priced contribution keeps even a buyer merge at full price", async () => {
      seedSplitCartMocks([BOGO_5_1], "MANUAL");

      await service.mergeAllPendingForCustomer("cust-1", { buyerInitiated: true });

      const data = prisma.orderItem.update.mock.calls[0][0].data;
      expect(data.boxes).toBe(6);
      // A deliberate operator price is never discounted further by a customer promo.
      expect(data.promoFreeUnits).toBeUndefined();
      expect(data.subtotal).toBe(6 * 35);
    });

    it("an at-door CHANGE_QTY down to 2 boxes bills BOTH boxes ($70), never $0.00", async () => {
      const line = bogoBoxLine("li-1", "ord-1", 12, 2);
      prisma.changeRequest.findUnique.mockResolvedValue({
        id: "cr-1",
        tenantId: "test-tenant",
        orderId: "ord-1",
        orderItemId: "li-1",
        productId: null,
        routeRunStopId: "stop-1",
        type: "CHANGE_QTY",
        status: "PENDING",
        payload: { orderItemId: "li-1", newQty: 200 },
        note: null,
        requestedById: "user-cust",
        requestedByName: "Buyer Co",
        requestedByRole: "CUSTOMER",
      });
      prisma.order.findUnique.mockResolvedValue({
        id: "ord-1",
        customerId: "cust-1",
        orderNumber: "ORD-123",
        status: "OUT_FOR_DELIVERY",
        subtotal: 350,
        tax: 0,
        total: 350,
        routeRunId: "run-1",
        routeRunStopId: "stop-1",
        lineItems: [line],
        routeRun: { id: "run-1", status: "IN_PROGRESS", driverId: "drv-1" },
        routeRunStop: { id: "stop-1", status: "PENDING" },
      });
      prisma.changeRequest.updateMany.mockResolvedValue({ count: 1 });
      prisma.customer.findUnique.mockResolvedValue({ creditLimit: null, pricingTier: 1 });
      prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });
      prisma.product.findUnique.mockResolvedValue({ category: null });
      ((service as any).promotionsService.activeForCatalog as jest.Mock).mockResolvedValue([
        BOGO_5_1,
      ]);

      await service.approveChangeRequestAtStop("cr-1", operatorPayload, null);

      const data = prisma.orderItem.update.mock.calls[0][0].data;
      // 2 units earn floor(2/6) * 1 = 0 free. Re-applying the stored 2 free
      // against a 2-box line billed the customer $0.00 for both boxes.
      expect(data.subtotal).toBe(2 * 35);
      expect(data.subtotal).not.toBe(0);
      expect(data.promoFreeUnits).toBeNull();
    });
  });
});

// ─── Invoice derivation copies the subtotal verbatim (#181 / #288) ───────────

describe("invoice derivation copies a BUY_N_GET_M line's subtotal verbatim (#181/#288)", () => {
  it("buildInvoiceItemData copies the exact freeUnits-adjusted subtotal, never qty*unitPrice", () => {
    // A BUY_N_GET_M line as OrdersService persists it: $35 base price, 12 units
    // ordered, 2 free -> subtotal $350.00 exact (computeLineSubtotal with
    // freeUnits: 2 at order-create time — see the "exactness" spec above).
    const orderLine = {
      id: "li-bogo",
      productId: "prod-plain",
      name: null,
      qty: 12,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      unitPrice: 35,
      subtotal: 350,
      originalPrice: null,
      priceType: "PROMO",
      promoFreeUnits: 2,
      notes: null,
      trackedCategoryId: null,
      trackedSubcategoryId: null,
      categoryTaxAmount: 0,
      invoicedQty: 0,
    };

    // buildInvoiceItemData (invoices.service.ts) is TS-private but touches no
    // `this` state — it's a pure function of (li, billQty, tenantId, opts); see
    // its own "COPY, DON'T RECOMPUTE" docstring. Call the REAL implementation
    // directly off the prototype (bypassing the constructor entirely) so this
    // pins the actual shipped code, not a re-description of it.
    const invoicesProto = Object.create(InvoicesService.prototype) as any;

    // Full bill from scratch (prior 0, billQty = the order line's full qty) — the
    // createInvoiceFromOrder AND the #288 resyncOrderInvoicesForEdit ("order"
    // basis) case.
    const invoiceItem = invoicesProto.buildInvoiceItemData(orderLine, 12, "tenant-1");

    expect(invoiceItem.subtotal).toBe(350);
    expect(invoiceItem.subtotal).not.toBe(12 * 35); // never the naive re-derive
    expect(invoiceItem.unitPrice).toBe(35);
    expect(invoiceItem.originalPrice).toBeNull();
    expect(invoiceItem.priceType).toBe("PROMO");

    // A partial re-bill (already billed 6, now billing the remaining 6) must
    // still sum to the exact $350 via telescoping cumulative rounding — not
    // 6 * $35 = $210 for the second half (the naive re-derive on the remainder).
    const firstHalf = invoicesProto.buildInvoiceItemData(orderLine, 6, "tenant-1");
    const secondHalf = invoicesProto.buildInvoiceItemData(orderLine, 6, "tenant-1", {
      priorBilledQty: 6,
    });
    expect(firstHalf.subtotal + secondHalf.subtotal).toBe(350);
  });

  it("carries promoFreeUnits onto the invoice line so a DRAFT edit can't re-price it", () => {
    // Copying the subtotal is not enough: the DRAFT edit path REPLACES every line
    // and re-prices it from the payload. Without the snapshot on the invoice line
    // there is nothing for the edit form to send back, and a plain re-save bills
    // 12 x $35 = $420 for the $350 the order agreed.
    const orderLine = {
      id: "li-bogo",
      productId: "prod-plain",
      name: null,
      qty: 12,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      unitPrice: 35,
      subtotal: 350,
      originalPrice: null,
      priceType: "PROMO",
      promoFreeUnits: 2,
      notes: null,
      trackedCategoryId: null,
      trackedSubcategoryId: null,
      categoryTaxAmount: 0,
      invoicedQty: 0,
    };
    const invoicesProto = Object.create(InvoicesService.prototype) as any;

    expect(invoicesProto.buildInvoiceItemData(orderLine, 12, "tenant-1").promoFreeUnits).toBe(2);

    // Partials split the free units the SAME telescoping way as the subtotal, so
    // Σ(partials) is exactly the order line's 2 — never 2 free on every partial.
    const firstHalf = invoicesProto.buildInvoiceItemData(orderLine, 6, "tenant-1");
    const secondHalf = invoicesProto.buildInvoiceItemData(orderLine, 6, "tenant-1", {
      priorBilledQty: 6,
    });
    expect(firstHalf.promoFreeUnits).toBe(1);
    expect(secondHalf.promoFreeUnits).toBe(1);

    // A non-BOGO line stays null — nothing about the existing shape changes.
    expect(
      invoicesProto.buildInvoiceItemData({ ...orderLine, promoFreeUnits: null }, 12, "tenant-1")
        .promoFreeUnits,
    ).toBeNull();
  });
});

describe("merge never stacks BUY_N_GET_M free units onto a price-promo-discounted line", () => {
  // Promotions are single, non-stacking, best-of. The merge path deliberately
  // never re-evaluates price promos — the surviving line keeps its stored (net)
  // unitPrice for the combined qty — so if that price already carries a
  // PERCENT/FIXED/QTY_BREAK discount, granting BOGO free units on top would give
  // a buyer's split-then-merged carts a cheaper total than the same quantity
  // ordered in one cart. `pricePromoApplied` suppresses BOTH the live re-derive
  // and the stored-snapshot rescale in that case.
  const ordersProto = Object.create(OrdersService.prototype) as any;
  const bogoRule = {
    id: "promo-bogo",
    type: "BUY_N_GET_M" as const,
    value: 1,
    minQty: 5,
    scope: "ALL" as const,
  };
  const contrib = (qty: number, over: Record<string, unknown> = {}) => ({
    qty,
    boxes: null,
    pieces: null,
    promoFreeUnits: null,
    priceType: "PROMO",
    overriddenBy: null,
    ...over,
  });

  it("discounted merged price (pricePromoApplied) -> 0 free units, discount kept", () => {
    // Winner line already PERCENT-discounted: $40 base struck through to $30 net.
    const merged = ordersProto.mergeBoxedContributions([contrib(6), contrib(6)], 30, null, {
      promos: [bogoRule],
      productId: "p1",
      category: null,
      canEarnNew: true,
      pricePromoApplied: true,
    });
    expect(merged.freeUnits).toBe(0);
    // 12 units, all at the discounted price, none free: 12 x $30 = $360 exact.
    expect(merged.subtotal).toBe(360);
  });

  it("stored snapshots are suppressed too, and reported so callers null them", () => {
    const merged = ordersProto.mergeBoxedContributions(
      [contrib(6, { promoFreeUnits: 1 }), contrib(6)],
      30,
      null,
      { promos: [bogoRule], productId: "p1", category: null, pricePromoApplied: true },
    );
    expect(merged.freeUnits).toBe(0);
    expect(merged.storedFreeUnits).toBe(1); // callers use this to clear the stale snapshot
    expect(merged.subtotal).toBe(360);
  });

  it("control: the same merge without a price discount earns its free units", () => {
    const merged = ordersProto.mergeBoxedContributions(
      [contrib(6, { priceType: "STANDARD" }), contrib(6, { priceType: "STANDARD" })],
      35,
      null,
      {
        promos: [bogoRule],
        productId: "p1",
        category: null,
        canEarnNew: true,
        pricePromoApplied: false,
      },
    );
    // floor(12 / 6) = 2 free; (12 - 2) x $35 = $350.00 exact.
    expect(merged.freeUnits).toBe(2);
    expect(merged.subtotal).toBe(350);
  });
});
