// SA-429 (#2377): these driver cases pin OTHER behaviour (pricing, merges, restrictions, returns),
// not ownership, and their mocks carry no assigned run; the ownership predicate itself is pinned by
// driver-edit-access.spec.ts and driver-edit-access.db.spec.ts.
jest.mock("./driver-edit-access", () => ({ assertDriverMayEditOrder: jest.fn() }));
/**
 * #2716c — staff price-override classification converges on ONE rule (`decideStaffOverride`):
 * below list => DISCOUNTED, at/above list => MANUAL, originalPrice = LIST, in three
 * updateOrderItems arms: (B) existing-line edit, (C) add-line-during-edit, and the replaceAll
 * changed-price arm. Forward-only: an untouched line keeps its stored type. SIBLING spec
 * (orders.service.spec.ts is at its size-ratchet cap).
 */
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
import { BadRequestException } from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";
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

describe("OrdersService — staff price-override rule (#2716c)", () => {
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

  // ─── T3 (REG-B47): folded merge item persists box-aware, not raw qty*price ──

  // list 6, tier-3 price 5 (special tier), customer tier 3 unless a test says otherwise.
  const PRODUCT = {
    id: "prod-1",
    name: "Tiered Widget",
    pricePerUnit: 6,
    priceTier3: 5,
    unitsPerBox: null,
    category: null,
    trackedCategoryId: null,
    trackedSubcategoryId: null,
  };
  const line = (over: Record<string, unknown> = {}) => ({
    id: "li-1",
    orderId: "ord-1",
    productId: "prod-1",
    qty: 3,
    unitPrice: 4.99,
    subtotal: 14.97,
    status: "PENDING",
    boxes: null,
    pieces: null,
    priceType: "STANDARD",
    originalPrice: null,
    overrideReason: null,
    ...over,
  });
  function prime(lineItems: unknown[], tier = 1) {
    prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, status: "DRAFT", lineItems });
    prisma.customer.findFirst.mockResolvedValue({ pricingTier: tier });
    prisma.customerPrice.findMany.mockResolvedValue([]);
    prisma.product.findFirst.mockResolvedValue(PRODUCT);
    prisma.product.findUnique.mockResolvedValue(PRODUCT);
    prisma.product.findMany.mockResolvedValue([PRODUCT]);
    prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 12, status: "PENDING" }]);
  }
  const edit = (unitPrice: number, extra: Record<string, unknown> = {}) =>
    service.updateOrderItems(
      "ord-1",
      { items: [{ id: "li-1", action: "UPDATE", qty: 3, unitPrice, ...extra }] } as any,
      operatorPayload as any,
    );
  const updated = () => (prisma.orderItem.update as jest.Mock).mock.calls[0][0].data;
  const created = () => (prisma.orderItem.create as jest.Mock).mock.calls[0][0].data;

  describe("(B) existing-line edit", () => {
    it("B1: an edit below list stores DISCOUNTED with originalPrice = list, never MANUAL", async () => {
      prime([line()]);
      await edit(4, { overrideReason: "promo" });
      expect(updated()).toMatchObject({
        unitPrice: 4,
        subtotal: 12,
        priceType: "DISCOUNTED",
        originalPrice: 6,
        overriddenBy: "user-op",
      });
    });

    it("B2: an edit above list stays MANUAL, anchored to list", async () => {
      prime([line()]);
      await edit(8, { overrideReason: "market" });
      expect(updated()).toMatchObject({ unitPrice: 8, priceType: "MANUAL", originalPrice: 6 });
    });

    it("B3: originalPrice is the product LIST, not the stored originalPrice or the stored price", async () => {
      prime([line({ priceType: "SPECIAL", originalPrice: 5, unitPrice: 4.99 })]);
      await edit(4, { overrideReason: "promo" });
      expect(updated().originalPrice).toBe(6);
    });

    it("B4: a stored MANUAL-below-list row is NOT rewritten by a within-half-cent edit", async () => {
      prime([line({ priceType: "MANUAL", originalPrice: 6, unitPrice: 4, overrideReason: "old" })]);
      await edit(4.003);
      const d = updated();
      expect(d).not.toHaveProperty("priceType");
      expect(d).not.toHaveProperty("originalPrice");
      expect(d.unitPrice).toBe(4);
    });

    it("B5: special-tier line, no reason sent or stored is refused; a stored reason counts", async () => {
      prime([line({ priceType: "SPECIAL", originalPrice: 6, unitPrice: 5 })], 3);
      await expect(edit(4)).rejects.toThrow(BadRequestException);
      expect(prisma.orderItem.update).not.toHaveBeenCalled();
      prime(
        [line({ priceType: "SPECIAL", originalPrice: 6, unitPrice: 5, overrideReason: "r" })],
        3,
      );
      await edit(4);
      expect(updated()).toMatchObject({ priceType: "DISCOUNTED", originalPrice: 6 });
    });
  });

  describe("restore: the tier price typed back on an edited line (SA-592 fold 2)", () => {
    it("B6: stored DISCOUNTED-4 (reason on file) on tier 3, typed 5 => SPECIAL/list, reason and attribution cleared", async () => {
      prime(
        [line({ priceType: "DISCOUNTED", originalPrice: 6, unitPrice: 4, overrideReason: "old" })],
        3,
      );
      await edit(5);
      expect(updated()).toMatchObject({
        unitPrice: 5,
        priceType: "SPECIAL",
        originalPrice: 6,
        overrideReason: null,
        overriddenBy: null,
      });
    });

    it("B7: tier-1 line stored DISCOUNTED-4, typed list 6 => STANDARD, no original, no reason", async () => {
      prime([line({ priceType: "DISCOUNTED", originalPrice: 6, unitPrice: 4 })]);
      await edit(6);
      expect(updated()).toMatchObject({
        unitPrice: 6,
        priceType: "STANDARD",
        originalPrice: null,
        overrideReason: null,
        overriddenBy: null,
      });
    });
  });

  describe("(C) add-line-during-edit", () => {
    const add = (unitPrice: number, extra: Record<string, unknown> = {}) =>
      service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-1", qty: 2, unitPrice, ...extra }], replaceAll: false } as any,
        operatorPayload as any,
      );

    it("C1/C2: below list is DISCOUNTED, above list is MANUAL, both originalPrice = list", async () => {
      prime([]);
      await add(4, { overrideReason: "x" });
      expect(created()).toMatchObject({ unitPrice: 4, priceType: "DISCOUNTED", originalPrice: 6 });
      (prisma.orderItem.create as jest.Mock).mockClear();
      await add(8, { overrideReason: "x" });
      expect(created()).toMatchObject({ unitPrice: 8, priceType: "MANUAL", originalPrice: 6 });
    });

    it("C3: special tier, typed at the tier price with no reason: SPECIAL/list, no refusal, no attribution", async () => {
      prime([], 3);
      await add(5);
      expect(created()).toMatchObject({
        unitPrice: 5,
        priceType: "SPECIAL",
        originalPrice: 6,
        overrideReason: null,
        overriddenBy: null,
      });
    });

    it("C4: special tier, a different price with no reason is refused", async () => {
      prime([], 3);
      await expect(add(4)).rejects.toThrow(BadRequestException);
    });

    it("C5: non-special typed at list stays STANDARD with no original", async () => {
      prime([]);
      await add(6);
      expect(created()).toMatchObject({ unitPrice: 6, priceType: "STANDARD", originalPrice: null });
    });
  });

  describe("replaceAll changed-price arm (SA-558d)", () => {
    const replace = (unitPrice: number, extra: Record<string, unknown> = {}) =>
      service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-1", qty: 3, unitPrice, ...extra }], replaceAll: true } as any,
        operatorPayload as any,
      );

    it("R1/R2: a re-created line typed below list is DISCOUNTED, above list MANUAL, original = list", async () => {
      prime([]);
      await replace(4, { overrideReason: "x" });
      expect(created()).toMatchObject({ priceType: "DISCOUNTED", originalPrice: 6, unitPrice: 4 });
      (prisma.orderItem.create as jest.Mock).mockClear();
      await replace(8, { overrideReason: "x" });
      expect(created()).toMatchObject({ priceType: "MANUAL", originalPrice: 6, unitPrice: 8 });
    });

    it("R3: an echo of a stored MANUAL-below-list line keeps MANUAL/list/reason (no re-stamp)", async () => {
      prime([line({ priceType: "MANUAL", originalPrice: 6, unitPrice: 4, overrideReason: "old" })]);
      await replace(4.003);
      expect(created()).toMatchObject({
        priceType: "MANUAL",
        originalPrice: 6,
        unitPrice: 4,
        overrideReason: "old",
      });
    });

    it("R5: stored DISCOUNTED-4 on tier 3, typed 5 (the tier price) => SPECIAL/list, reason cleared", async () => {
      prime(
        [line({ priceType: "DISCOUNTED", originalPrice: 6, unitPrice: 4, overrideReason: "old" })],
        3,
      );
      await replace(5);
      expect(created()).toMatchObject({
        priceType: "SPECIAL",
        originalPrice: 6,
        unitPrice: 5,
        overrideReason: null,
        overriddenBy: null,
      });
    });

    it("R4: a changed price against the stored line is DISCOUNTED when below list", async () => {
      prime([line()]);
      await replace(4, { overrideReason: "x" });
      expect(created()).toMatchObject({ priceType: "DISCOUNTED", originalPrice: 6, unitPrice: 4 });
    });
  });

  describe("source pin (one rule, no local classifier)", () => {
    const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");
    it("S1: replace-all-line-build stamps no MANUAL itself; orders.service keeps only the legitimate branches", () => {
      expect(read("replace-all-line-build.ts")).not.toMatch(/PriceType\.MANUAL/);
      const n = (read("orders.service.ts").match(/PriceType\.MANUAL/g) ?? []).length;
      // create unlisted + create upsell + 3 unlisted-add sites + substitute (owned by #2696c)
      expect(n).toBeLessThanOrEqual(6);
      expect(read("staff-line-price.ts")).toMatch(/decideStaffOverride/);
    });
  });
});
