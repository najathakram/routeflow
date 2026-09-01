/**
 * F06 — updateOrderItems authorization + line build (test plan TP2).
 *
 * Proves T3-T13 from
 * `.claude/pipeline/2026-08-31-f06-update-order-items/{spec,test-plan,build-plan}.md`:
 * REG-B47 (denomination-aware persistence of a folded merge item), REG-B51
 * (buyer edits can neither author nor drop an unlisted line), REG-B63 (a
 * CUSTOMER items-edit is refused on a post-dispatch order, before any side
 * effect), REG-B60 (a staff replaceAll preserves + rescales an existing
 * BUY_N_GET_M snapshot instead of destroying it, and never over-reaches onto
 * a genuinely repriced line).
 *
 * It also carries T14's SERVICE-side leg (REG-B78): `applyBuyerMergeHeader`'s
 * own merge semantics + ownership guard, exercised against the REAL method.
 * TP3 (`../buyer/buyer.controller.merge.spec.ts`) mocks OrdersService wholesale,
 * so it can only prove the controller FORWARDS the header — test-plan §2 T14
 * requires the semantics themselves be proven "service-side in the guards spec".
 * That leg was ADDED AT REVIEW TIME, after the red gate ran, so it is not part
 * of the must-fail set described below; it opens with an explicit existence pin
 * so a tree without the method (pre-fix, or under a mutation probe that deletes
 * it) fails as an ASSERTION rather than as a "not a function" TypeError.
 *
 * RED BY DESIGN: none of the five guards below exist on `orders.service.ts`
 * yet. Every non-pin `it()` fails on an assertion against today's tree — see
 * test-plan.md §6 for the exact expected failure per test. T6/T8/T9/T12 are
 * regression PINS (already green today) living in describes literally titled
 * "(pin — green pre-fix)" — the campaign's red-gate auditor excludes them
 * from the must-fail set.
 *
 * Harness copied from `orders.service.spec.ts`'s `updateOrderItems` describes
 * (mocked PrismaService via `createMockPrisma()`, `forTenant()`/
 * `tenantTransaction` pass-through, mocked InvoicesService/PromotionsService).
 * Expected money/free-unit values are hand-derived per test-plan §2.1 —
 * NEVER recomputed via the implementation's own helper chain here.
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

import { Test, TestingModule } from "@nestjs/testing";
import { ForbiddenException } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";

import { OrdersService } from "./orders.service";
import { InvoicesService } from "../invoices/invoices.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PrismaService } from "../prisma/prisma.service";
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

describe("OrdersService — F06 guards (TP2)", () => {
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
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
    invoicesService = module.get(InvoicesService);
    promotionsService = module.get(PromotionsService);
  });

  // ─── T3 (REG-B47): folded merge item persists box-aware, not raw qty*price ──

  describe("updateOrderItems — CUSTOMER folded merge item on a box-unaware line (T3 / REG-B47)", () => {
    /**
     * The register fixture: ONE pre-existing box-UNAWARE line (boxes/pieces
     * null) of a BOXED product — pricing.ts's contract makes its `qty` a count
     * of SELLING UNITS and its `unitPrice` the BOX price. upb 12, box $10.00.
     */
    function primeBoxUnawareLine() {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "PENDING",
        lineItems: [
          {
            id: "li-boxunaware",
            orderId: "ord-1",
            productId: "prod-box",
            qty: 2,
            unitPrice: 10,
            subtotal: 20,
            status: "PENDING",
            boxes: null,
            pieces: null,
            priceType: "STANDARD",
            originalPrice: null,
          },
        ],
      });
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
      prisma.product.findMany.mockResolvedValue([
        {
          id: "prod-box",
          pricePerUnit: 10,
          unitsPerBox: 12,
          category: null,
          trackedCategoryId: null,
          trackedSubcategoryId: null,
        },
      ]);
      prisma.orderItem.findMany.mockResolvedValue([]);
    }

    it("REG-B47 (T3): a folded {qty:36,boxes:3,pieces:0} item bills 3 boxes, not 36 raw units", async () => {
      primeBoxUnawareLine();

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-box", qty: 36, boxes: 3, pieces: 0 }] },
        customerPayload,
      );

      const created = prisma.orderItem.create.mock.calls[0][0].data;
      // ONE assertion so the REG-B47 money claim is what the red diff reports:
      // separate expects die on `boxes` and the subtotal is never observed.
      // hand: 3 boxes x $10.00 box price = $30.00 — never 36 raw x $10 = $360.00.
      expect(created).toMatchObject({ boxes: 3, pieces: 0, qty: 36, subtotal: 30 });
    });

    it("REG-B47 (T3): an INCONSISTENT client split is ignored — the split is re-derived from qty alone", async () => {
      // B13 posture (dto/update-order-items.dto.ts): boxes/pieces are a
      // denomination SIGNAL on the buyer path, never trusted verbatim. The
      // payload above is already self-consistent with normalizeBoxesPieces(
      // {qty:36, unitsPerBox:12}), so it passes just as well against an
      // implementation that honours the client's split — this one does not.
      primeBoxUnawareLine();

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-box", qty: 36, boxes: 99, pieces: 7 }] },
        customerPayload,
      );

      const created = prisma.orderItem.create.mock.calls[0][0].data;
      // hand: qty 36 / upb 12 = 3 boxes + 0 pieces = $30.00. Honouring the
      // claimed split verbatim would bill 99 boxes + 7 pieces = $995.83.
      expect(created).toMatchObject({ boxes: 3, pieces: 0, qty: 36, subtotal: 30 });
    });

    it("REG-B47 (T3): the split signal re-denominates an existing selling-unit line, and the money follows qty", async () => {
      // The mirror image: the same box-unaware line, but the buyer's payload
      // marks it piece-denominated at a SMALLER qty. `qty` stays the authority
      // (pieces — what the merge fold emits), so the line becomes 2 loose
      // pieces and bills the prorated box price for exactly those 2 pieces:
      // quantity and money move together, so this is a denomination change the
      // buyer asked for, not an under-bill. Pinned so a future edit of the
      // shouldSplit gate cannot move this money silently in either direction.
      primeBoxUnawareLine();

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-box", qty: 2, boxes: 1 }] },
        customerPayload,
      );

      const created = prisma.orderItem.create.mock.calls[0][0].data;
      // hand: 0 boxes + 2 loose pieces of a 12-piece $10.00 box =
      // $10.00 x 2/12 = $1.6666… → $1.67 at the cent.
      expect(created).toMatchObject({ boxes: 0, pieces: 2, qty: 2, subtotal: 1.67 });
    });

    describe("T3 control (pin — green pre-fix)", () => {
      it("the same qty with NO split signal keeps the line selling-unit denominated at the box price", async () => {
        // Without boxes/pieces the pre-existing box-UNAWARE protection stands:
        // `qty` still counts SELLING UNITS, so 2 x $10.00 = $20.00. That is what
        // makes the case above a signal-driven denomination change rather than a
        // regression of that protection.
        primeBoxUnawareLine();

        await service.updateOrderItems(
          "ord-1",
          { items: [{ productId: "prod-box", qty: 2 }] },
          customerPayload,
        );

        const created = prisma.orderItem.create.mock.calls[0][0].data;
        expect(created).toMatchObject({ boxes: null, pieces: null, qty: 2, subtotal: 20 });
      });
    });
  });

  // ─── T4 (REG-B51): a stored unlisted line survives a buyer full-replace ─────

  describe("updateOrderItems — CUSTOMER edits preserve a stored unlisted line (T4 / REG-B51)", () => {
    it("REG-B51 (T4): a stored unlisted row survives a catalog-only CUSTOMER replace, and the order total still counts it", async () => {
      // An in-memory line store, so the delete/create calls the service actually
      // issues DECIDE the outcome and the assertions below read STATE, never a
      // query shape. Any correct implementation passes — a scoped deleteMany, a
      // delete-by-explicit-id list, preserve-then-restore — and any that drops
      // the row (or re-creates/reprices it) fails.
      const unlistedRow = {
        id: "li-unlisted",
        orderId: "ord-1",
        productId: null as string | null,
        name: "Setup fee",
        qty: 1,
        unitPrice: 25,
        subtotal: 25,
        status: "PENDING",
        notes: null as string | null,
        priceType: "MANUAL",
      };
      const lines: Array<Record<string, any>> = [{ ...unlistedRow }];

      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "PENDING",
        lineItems: [{ ...unlistedRow }],
      });
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
      prisma.product.findMany.mockResolvedValue([
        {
          id: "prod-x",
          pricePerUnit: 5,
          unitsPerBox: null,
          category: null,
          trackedCategoryId: null,
          trackedSubcategoryId: null,
        },
      ]);
      // The mock interprets every where-shape a CORRECT implementation could
      // plausibly scope the delete with, so this test can only fail on the
      // OUTCOME (was the unlisted row destroyed?) and never on a query shape it
      // did not anticipate. Understanding only `productId` would treat a
      // delete-by-explicit-id (`where: { id: { in: [...] } }`) as "delete
      // everything" and fail a correct fix for the wrong reason.
      const matchesIdRule = (li: Record<string, any>, rule: any): boolean => {
        if (rule !== null && typeof rule === "object") {
          if (Array.isArray(rule.in)) return rule.in.includes(li.id);
          if (Array.isArray(rule.notIn)) return !rule.notIn.includes(li.id);
          return false;
        }
        return li.id === rule;
      };
      const matchesProductIdRule = (li: Record<string, any>, rule: any): boolean =>
        rule !== null && typeof rule === "object"
          ? rule.not === null
            ? li.productId !== null
            : li.productId !== rule.not
          : li.productId === rule;
      prisma.orderItem.deleteMany.mockImplementation(({ where }: any) => {
        const before = lines.length;
        for (let i = lines.length - 1; i >= 0; i--) {
          const li = lines[i];
          if (where?.orderId !== undefined && where.orderId !== li.orderId) continue;
          // Prisma ANDs the clauses of one `where`; a where naming neither `id`
          // nor `productId` scopes to the whole order (today's unscoped delete).
          if (where?.id !== undefined && !matchesIdRule(li, where.id)) continue;
          if (where?.productId !== undefined && !matchesProductIdRule(li, where.productId)) {
            continue;
          }
          lines.splice(i, 1);
        }
        return Promise.resolve({ count: before - lines.length });
      });
      prisma.orderItem.create.mockImplementation(({ data }: any) => {
        const row = { id: `li-new-${lines.length}`, ...data };
        lines.push(row);
        return Promise.resolve(row);
      });
      prisma.orderItem.update.mockImplementation(({ where, data }: any) => {
        const row = lines.find((l) => l.id === where?.id);
        if (row) Object.assign(row, data);
        return Promise.resolve(row ?? {});
      });
      // Three reads hit the store: the B51 position re-stamp asks for the
      // SURVIVING unlisted rows (`productId: null`), the totals recompute is the
      // sole read filtering on `status`, and the pre-edit hold snapshot (plus
      // the buyer price-history read) keeps today's empty default.
      prisma.orderItem.findMany.mockImplementation(({ where }: any) =>
        Promise.resolve(
          where?.productId === null
            ? lines.filter((l) => l.productId === null)
            : where?.status
              ? [...lines]
              : [],
        ),
      );

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-x", qty: 1 }] },
        customerPayload,
      );

      // R2 preservation-by-design: the row survives IN PLACE — same id (invoice
      // and delivery references stay valid), same authoring, same money.
      const survivor = lines.find((l) => l.id === "li-unlisted");
      expect(survivor).toMatchObject({
        id: "li-unlisted",
        productId: null,
        name: "Setup fee",
        qty: 1,
        unitPrice: 25,
        notes: null,
      });
      // …and it is preserved, not deleted-then-recreated (a new row would have a
      // fresh id and break those references).
      expect(prisma.orderItem.create).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ productId: null }) }),
      );
      // hand: $25.00 preserved unlisted + $5.00 prod-x (list, tier 1) = $30.00.
      // Today the unscoped delete wipes the unlisted row, so the order is
      // rewritten to $5.00 — the customer's fee silently vanishes off the total.
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ subtotal: 30 }) }),
      );
      // R2's "client array order" contract on a MIXED order: the client's own
      // line takes position 0 and the preserved row is re-stamped AFTER it, so a
      // survivor can never keep a position that collides with a freshly created
      // line and silently reorder the invoice.
      expect(lines.find((l) => l.productId === "prod-x")).toMatchObject({ position: 0 });
      expect(survivor).toMatchObject({ position: 1 });
    });
  });

  // ─── T5 (REG-B51, negative): a buyer can never author an unlisted line ──────

  describe("updateOrderItems — CUSTOMER cannot author a new unlisted line (T5 / REG-B51)", () => {
    it("REG-B51 (T5): a buyer payload naming an unlisted line at any price is never created", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "PENDING",
        lineItems: [],
      });
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
      prisma.orderItem.findMany.mockResolvedValue([]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ name: "X", qty: 1, unitPrice: 99999 }] },
        customerPayload,
      );

      expect(prisma.orderItem.create).not.toHaveBeenCalled();
    });
  });

  // ─── T6 (pin — green pre-fix): DRIVER unlisted authoring is unchanged ───────

  describe("updateOrderItems — DRIVER unlisted authoring (T6, pin — green pre-fix)", () => {
    it("a DRIVER non-diff edit still creates an unlisted line exactly as today", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "PENDING",
        lineItems: [],
      });
      prisma.orderItem.findMany.mockResolvedValue([]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ name: "Fuel surcharge", qty: 1, unitPrice: 12 }] },
        driverPayload,
      );

      expect(prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: null,
            name: "Fuel surcharge",
            qty: 1,
            unitPrice: 12,
            priceType: "MANUAL",
          }),
        }),
      );
    });
  });

  // ─── T7 (REG-B63, negative): CUSTOMER post-dispatch edit is refused ─────────

  describe("updateOrderItems — CUSTOMER post-dispatch edit is refused (T7 / REG-B63)", () => {
    /**
     * The fixture is deliberately COMPLETE — ownership passes, the product
     * resolves, stock/credit clear — so the edit would SUCCEED end to end if
     * nothing refused it. Without that, `createMockPrisma`'s `customer.findFirst
     * → null` default hits the PRE-EXISTING ownership guard (orders.service.ts
     * :2896-2897) and the 403 arrives for a reason that has nothing to do with
     * the order's status: R4 would then look proven while no status gate exists.
     */
    function primePostDispatchFixture(status: string) {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status,
        lineItems: [],
      });
      // MOCK_ORDER.customerId === "cust-1" → ownership PASSES.
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
      prisma.product.findMany.mockResolvedValue([
        {
          id: "prod-x",
          pricePerUnit: 5,
          unitsPerBox: null,
          category: null,
          trackedCategoryId: null,
          trackedSubcategoryId: null,
        },
      ]);
      prisma.orderItem.findMany.mockResolvedValue([]);
    }

    it.each(["OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED", "DELIVERED"] as const)(
      "REG-B63 (T7): a CUSTOMER items-edit on a %s order is refused before any side effect",
      async (status) => {
        primePostDispatchFixture(status);
        const revisionSpy = jest
          .spyOn(service as any, "appendOrderRevision")
          .mockResolvedValue(undefined);

        const attempt = service.updateOrderItems(
          "ord-1",
          { items: [{ productId: "prod-x", qty: 1 }] },
          customerPayload,
        );

        await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
        // spec §4: the 403 must name the change-request flow — so a bare
        // ForbiddenException from some unrelated guard cannot satisfy R4.
        await expect(attempt).rejects.toThrow(/change request/i);

        // Thrown before the transaction ever opens — zero side effects.
        expect(prisma.tenantTransaction).not.toHaveBeenCalled();
        expect(invoicesService.revertLinkedInvoicesForOrderEdit).not.toHaveBeenCalled();
        expect(prisma.orderItem.deleteMany).not.toHaveBeenCalled();
        expect(prisma.orderItem.create).not.toHaveBeenCalled();
        expect(revisionSpy).not.toHaveBeenCalled();
      },
    );

    describe("T7 control (pin — green pre-fix)", () => {
      it("the same CUSTOMER edit on a PENDING order is NOT refused — the 403 is status-driven, not fixture-driven", async () => {
        primePostDispatchFixture("PENDING");

        await expect(
          service.updateOrderItems(
            "ord-1",
            { items: [{ productId: "prod-x", qty: 1 }] },
            customerPayload,
          ),
        ).resolves.toBeDefined();
      });
    });
  });

  // ─── T7 companion (REG-B63): the read descriptor agrees with the write gate ─

  describe("findOne — the buyer edit window matches the B63 write gate (T7 companion / REG-B63)", () => {
    function primeFindOne(status: string) {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status,
        lineItems: [],
        revisions: [],
      });
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    }

    it("REG-B63: a CUSTOMER reading a post-dispatch order is told the window is CLOSED (DISPATCHED)", async () => {
      primeFindOne("OUT_FOR_DELIVERY");

      const order: any = await service.findOne("ord-1", customerPayload);

      // `closedReason` exists to tell a buyer client WHY editing is closed.
      // Reporting `editable: true` here promises an edit the write gate answers
      // with a 403 — an unexplained refusal for any client that trusts it.
      expect(order.editWindow).toMatchObject({ editable: false, closedReason: "DISPATCHED" });
    });

    it("REG-B63: an OPERATOR reading the same order still sees the window OPEN (R1 unchanged)", async () => {
      primeFindOne("OUT_FOR_DELIVERY");

      const order: any = await service.findOne("ord-1", operatorPayload);

      expect(order.editWindow).toMatchObject({ editable: true, closedReason: null });
    });

    it("REG-B63: a CUSTOMER reading a PENDING order still sees the window OPEN", async () => {
      primeFindOne("PENDING");

      const order: any = await service.findOne("ord-1", customerPayload);

      expect(order.editWindow).toMatchObject({ editable: true, closedReason: null });
    });
  });

  // ─── T8 (pin — green pre-fix): CUSTOMER CONFIRMED edit still reverts ────────

  describe("updateOrderItems — CUSTOMER CONFIRMED edit (T8, pin — green pre-fix)", () => {
    it("a CUSTOMER editing a CONFIRMED order succeeds and reverts it to PENDING", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "CONFIRMED",
        routeRun: null,
        lineItems: [
          {
            id: "li-1",
            orderId: "ord-1",
            productId: "prod-1",
            qty: 2,
            unitPrice: 5,
            subtotal: 10,
            status: "PENDING",
            boxes: null,
            pieces: null,
            priceType: "STANDARD",
            originalPrice: null,
          },
        ],
      });
      prisma.orderItem.findMany.mockResolvedValue([
        { id: "li-1", productId: "prod-1", qty: 3, unitPrice: 5, subtotal: 15, status: "PENDING" },
      ]);
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
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

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-1", qty: 3 }] },
        customerPayload,
      );

      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "ord-1" },
          data: expect.objectContaining({ status: "PENDING" }),
        }),
      );
    });
  });

  // ─── T9 (pin — green pre-fix): DRIVER post-dispatch edit is unaffected ──────

  describe("updateOrderItems — DRIVER post-dispatch edit (T9, pin — green pre-fix)", () => {
    it("a DRIVER non-diff edit on an OUT_FOR_DELIVERY order still succeeds", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "OUT_FOR_DELIVERY",
        routeRun: { status: "DISPATCHED", startedAt: new Date() },
        lineItems: [
          {
            id: "li-A",
            orderId: "ord-1",
            productId: "prod-A",
            qty: 2,
            unitPrice: 5,
            subtotal: 10,
            status: "PENDING",
            boxes: null,
            pieces: null,
          },
        ],
      });
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-A", pricePerUnit: 5, unitsPerBox: null },
      ]);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 20, status: "PENDING" }]);

      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ productId: "prod-A", qty: 4 }] },
          driverPayload,
        ),
      ).resolves.toBeDefined();

      // The DRIVER replace still deletes this order's lines. Asserted loosely on
      // purpose: pinning the EXACT where-shape here (paired with T4's) would
      // hard-code that the two branches must issue two DIFFERENT queries, so a
      // reasonable implementation scoping the delete once for both non-diff
      // branches would break a pin despite no observable DRIVER change. The
      // observable claim — unlisted authoring survives, catalog lines replace —
      // is carried by T6 and the resolves assertion above.
      expect(prisma.orderItem.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ orderId: "ord-1" }) }),
      );
    });
  });

  // ─── T10-T13 (REG-B60): staff replaceAll preserves + rescales BOGO snapshot ─

  const promoOrder = () => ({
    ...MOCK_ORDER,
    status: "DRAFT" as const,
    lineItems: [
      {
        id: "li-promo",
        orderId: "ord-1",
        productId: "prod-promo",
        qty: 10,
        unitPrice: 5,
        subtotal: 40, // 5.00 * (10 - 2 free)
        status: "PENDING",
        boxes: null,
        pieces: null,
        priceType: "PROMO",
        originalPrice: null,
        promoFreeUnits: 2,
      },
    ],
  });
  const promoProduct = {
    id: "prod-promo",
    pricePerUnit: 5,
    unitsPerBox: null,
    category: null,
    trackedCategoryId: null,
    trackedSubcategoryId: null,
  };
  // BUY 4 GET 1 (a block of 5 whole units): floor(10/5)*1 = 2 — matches the
  // line's stored snapshot at qty 10; floor(20/5)*1 = 4 at the new qty 20 —
  // the hand-derived oracle T10/T11 rescale to.
  const bogoRule = {
    id: "promo-bogo",
    type: "BUY_N_GET_M",
    value: 1,
    minQty: 4,
    scope: "ALL",
    category: null,
    productIds: [],
  };

  function primeBogoReplaceAll() {
    prisma.order.findUnique.mockResolvedValue(promoOrder());
    prisma.product.findMany.mockResolvedValue([promoProduct]);
    prisma.orderItem.findMany.mockResolvedValue([]);
    promotionsService.activeForCatalog.mockResolvedValue([bogoRule]);
  }

  describe("updateOrderItems — staff replaceAll preserves + rescales a BOGO snapshot (T10-T11 / REG-B60)", () => {
    it("REG-B60 (T10): an omitted price on replaceAll preserves + rescales the BOGO snapshot", async () => {
      primeBogoReplaceAll();

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-promo", qty: 20 }], replaceAll: true },
        operatorPayload,
      );

      const created = prisma.orderItem.create.mock.calls[0][0].data;
      expect(created.unitPrice).toBe(5);
      expect(created.priceType).toBe("PROMO");
      expect(created.promoFreeUnits).toBe(4);
      // hand: 5.00 * (20 - 4 free) = 80.00
      expect(created.subtotal).toBe(80);
    });

    it("REG-B60 (T11): a price that echoes the stored price is not an override — same outcome as omitted", async () => {
      primeBogoReplaceAll();

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-promo", qty: 20, unitPrice: 5 }], replaceAll: true },
        operatorPayload,
      );

      const created = prisma.orderItem.create.mock.calls[0][0].data;
      expect(created.priceType).toBe("PROMO");
      expect(created.priceType).not.toBe("MANUAL");
      expect(created.promoFreeUnits).toBe(4);
      expect(created.subtotal).toBe(80);
    });

    /**
     * Final-pass catch: an order may hold SEVERAL lines of one product (the
     * diff-add branch creates a new row for an id-less item even when a line for
     * that product exists), and a replaceAll payload carries no line ids. Keying
     * the counterpart by productId alone handed the snapshot AND the override
     * attribution to every echoed line of that product.
     *
     * Oracle, hand-derived from the qty-edit branch this arm copies: it rescales
     * a line's OWN storedFreeUnits and passes canEarnNew:false, so a sibling with
     * no snapshot earns 0 free units and bills in full. There is no sound N-to-N
     * mapping from stored to incoming lines here, so neither line may be granted
     * a snapshot: both bill at the resolved price with no free units.
     */
    it("REG-B60: a sibling line of the same product never inherits the snapshot on a no-op replaceAll", async () => {
      const twoLineOrder = promoOrder();
      twoLineOrder.lineItems.push({
        id: "li-plain",
        orderId: "ord-1",
        productId: "prod-promo",
        qty: 5,
        unitPrice: 5,
        subtotal: 25,
        status: "PENDING",
        boxes: null,
        pieces: null,
        priceType: "STANDARD",
        originalPrice: null,
        promoFreeUnits: 0,
      });
      prisma.order.findUnique.mockResolvedValue(twoLineOrder);
      prisma.product.findMany.mockResolvedValue([promoProduct]);
      prisma.orderItem.findMany.mockResolvedValue([]);
      promotionsService.activeForCatalog.mockResolvedValue([bogoRule]);

      // A no-op save: both lines echoed at their stored qty and price.
      await service.updateOrderItems(
        "ord-1",
        {
          items: [
            { productId: "prod-promo", qty: 10, unitPrice: 5 },
            { productId: "prod-promo", qty: 5, unitPrice: 5 },
          ],
          replaceAll: true,
        },
        operatorPayload,
      );

      const lines = prisma.orderItem.create.mock.calls.map((c: any) => c[0].data);
      expect(lines).toHaveLength(2);
      const sibling = lines.find((l: any) => Number(l.qty) === 5);
      // hand: 5.00 * 5 = 25.00. The productId-keyed map billed 5.00 * (5-1) = 20.00.
      expect(sibling.subtotal).toBe(25);
      expect(sibling.promoFreeUnits ?? 0).toBe(0);
      // and it must not wear the counterpart's override attribution
      expect(sibling.overrideReason ?? null).toBeNull();
      expect(sibling.overriddenBy ?? null).toBeNull();
    });
  });

  /**
   * A BOGO counterpart is ANY pre-edit line carrying `promoFreeUnits > 0` — not
   * only a PROMO one. `mergeAllPendingForCustomer` writes `promoFreeUnits` onto a
   * winner line while keeping that line's own priceType, so a SPECIAL (tier) or a
   * MANUAL (operator override) line can hold a snapshot too. The preservation arm
   * must then carry the WHOLE stored pricing identity across the re-create, exactly
   * as the qty-edit oracle does by leaving those columns untouched at an unchanged
   * price: a no-op operator save must not erase a strikethrough base, nor the
   * record of who authorized a price. The T10/T11 fixture above is PROMO with a
   * null originalPrice — the one case where writing null is legitimately correct.
   */
  describe("updateOrderItems — preservation keeps a non-PROMO counterpart's pricing identity (T10 variant / REG-B60)", () => {
    function primeCounterpart(line: Record<string, unknown>) {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [
          {
            id: "li-promo",
            orderId: "ord-1",
            productId: "prod-promo",
            qty: 10,
            unitPrice: 5,
            subtotal: 40, // 5.00 * (10 - 2 free)
            status: "PENDING",
            boxes: null,
            pieces: null,
            promoFreeUnits: 2,
            ...line,
          },
        ],
      });
      // List price 8.00 — deliberately ABOVE the line's stored 5.00, so a lost
      // strikethrough cannot hide behind an originalPrice that was null anyway.
      prisma.product.findMany.mockResolvedValue([{ ...promoProduct, pricePerUnit: 8 }]);
      prisma.orderItem.findMany.mockResolvedValue([]);
      promotionsService.activeForCatalog.mockResolvedValue([bogoRule]);
    }

    it("REG-B60 (T10 variant): a SPECIAL counterpart keeps its strikethrough base", async () => {
      primeCounterpart({ priceType: "SPECIAL", originalPrice: 8 });

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-promo", qty: 20 }], replaceAll: true },
        operatorPayload,
      );

      const created = prisma.orderItem.create.mock.calls[0][0].data;
      expect(created.priceType).toBe("SPECIAL");
      expect(created.originalPrice).toBe(8);
      expect(created.unitPrice).toBe(5);
      expect(created.promoFreeUnits).toBe(4);
      // hand: 5.00 * (20 - 4 free) = 80.00
      expect(created.subtotal).toBe(80);
    });

    it("REG-B60 (T10 variant): a MANUAL counterpart keeps its override attribution", async () => {
      primeCounterpart({
        priceType: "MANUAL",
        originalPrice: 8,
        overrideReason: "matched competitor quote",
        overriddenBy: "user-op-original",
      });

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-promo", qty: 20, unitPrice: 5 }], replaceAll: true },
        operatorPayload,
      );

      const created = prisma.orderItem.create.mock.calls[0][0].data;
      expect(created.priceType).toBe("MANUAL");
      expect(created.originalPrice).toBe(8);
      expect(created.overrideReason).toBe("matched competitor quote");
      // The ORIGINAL authorizer — not whoever pressed Save on this no-op edit.
      expect(created.overriddenBy).toBe("user-op-original");
    });
  });

  describe("updateOrderItems — a genuinely repriced BOGO line still flips MANUAL (T12, pin — green pre-fix)", () => {
    it("REG-B60 (T12): a price that differs from the stored price flips MANUAL with no snapshot", async () => {
      primeBogoReplaceAll();

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-promo", qty: 20, unitPrice: 4.2 }], replaceAll: true },
        operatorPayload,
      );

      const created = prisma.orderItem.create.mock.calls[0][0].data;
      expect(created.priceType).toBe("MANUAL");
      // Accepts both "key absent" (today) and "key null" (post-fix plumbing) —
      // this pin only guards against preservation over-reaching onto a
      // genuinely repriced line, not the R9 plumbing itself (see T13).
      expect(created.promoFreeUnits ?? null).toBeNull();
      // hand: 4.20 * 20 = 84.00 — no free units; the override replaces the promo.
      expect(created.subtotal).toBe(84);
    });
  });

  describe("updateOrderItems — freeUnits plumbing on both operator add blocks (T13 / REG-B60)", () => {
    function primeStaffAdd() {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT",
        lineItems: [],
      });
      prisma.product.findMany.mockResolvedValue([
        {
          id: "prod-new",
          pricePerUnit: 8,
          unitsPerBox: null,
          category: null,
          trackedCategoryId: null,
          trackedSubcategoryId: null,
        },
      ]);
      prisma.orderItem.findMany.mockResolvedValue([]);
    }

    /**
     * R9 is behavior-NEUTRAL by design: staff promos are `[]` (the P5-04
     * invariant), so freeUnits is always 0 here and no staff-visible money can
     * distinguish plumbed-through-correctly from hard-coded. Both cases below
     * are therefore STRUCTURAL, and a reviewer must NOT read them as proof of
     * R9: hard-coding `promoFreeUnits: null` on the create data, with no
     * freeUnits ever reaching `computeLineSubtotal`, satisfies them exactly
     * (the $40.00 subtotal is identical either way). What the money assertion
     * DOES catch is the plumbing being wired to the WRONG value (a qty, a
     * count, an off-by-one snapshot), which would move the subtotal off its
     * hand-derived $8.00 x 5 = $40.00. R9's teeth are elsewhere and are
     * mandatory: the test-plan §9 mutation probe on BOTH operator add blocks,
     * plus T10/T11, which drive the same freeUnits argument with a NON-zero
     * value and assert the resulting $80.00.
     */
    it("REG-B60 (T13): a staff diff-add of a fresh catalog line carries the promoFreeUnits key — structural (probe-backed)", async () => {
      primeStaffAdd();

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-new", qty: 5 }], replaceAll: false },
        operatorPayload,
      );

      const created = prisma.orderItem.create.mock.calls[0][0].data;
      // Structural: today the key is absent from create data entirely — staff
      // promos stay [] (P5-04 invariant), so the value is null, not a number.
      expect(created).toHaveProperty("promoFreeUnits");
      expect(created.promoFreeUnits).toBeNull();
      // hand: $8.00 list x 5 = $40.00, zero free units.
      expect(created.subtotal).toBe(40);
    });

    it("REG-B60 (T13): a staff replaceAll add of a fresh catalog line carries the promoFreeUnits key too — structural (probe-backed)", async () => {
      // R9 names BOTH operator add blocks; the diff-add case above only
      // exercises orders.service.ts's :3306-3405 arm, this one its :3141-3236
      // replaceAll arm.
      primeStaffAdd();

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-new", qty: 5 }], replaceAll: true },
        operatorPayload,
      );

      const created = prisma.orderItem.create.mock.calls[0][0].data;
      expect(created).toHaveProperty("promoFreeUnits");
      expect(created.promoFreeUnits).toBeNull();
      // hand: $8.00 list x 5 = $40.00, zero free units.
      expect(created.subtotal).toBe(40);
    });
  });

  // ─── T14 service leg (REG-B78): applyBuyerMergeHeader's own semantics ───────

  /**
   * `applyBuyerMergeHeader` is the SOLE owner of R10 / acceptance criterion 5
   * ("notes append, urgent=true sticks, urgent=false never clears, date sets
   * when provided") and of the buyer ownership check on that write. TP3 proves
   * only that the controller forwards `dto.notes/urgent/requestedDeliveryDate`
   * — it provides OrdersService via `useValue`, so the helper there is a
   * `jest.fn()`. These tests call the REAL method over the mocked Prisma so a
   * mutation of any of its four rules (drop the ownership guard; `urgent !==
   * undefined`; `data.notes = notes` clobbering the operator's note; dropping
   * the date parse) fails an assertion instead of shipping green.
   */
  describe("OrdersService.applyBuyerMergeHeader — merge semantics + ownership (T14 / REG-B78)", () => {
    const OWNED_ORDER = {
      id: "ord-1",
      customerId: "cust-1",
      notes: "Operator: leave at loading dock",
      urgent: true,
    };

    function primeHeader(order: Partial<typeof OWNED_ORDER> = {}) {
      prisma.order.findFirst.mockResolvedValue({ ...OWNED_ORDER, ...order });
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    }

    const headerData = () => prisma.order.update.mock.calls[0][0].data;

    it("REG-B78 (T14): OrdersService owns the helper at all — its absence is an assertion, not a TypeError", () => {
      // Every case below calls the real method; without this pin a tree that
      // never grew it (pre-fix, or a mutation probe that deletes it) reports
      // "service.applyBuyerMergeHeader is not a function", which reads like a
      // broken harness rather than an unmet requirement.
      expect(typeof (service as unknown as Record<string, unknown>).applyBuyerMergeHeader).toBe(
        "function",
      );
    });

    it("REG-B78 (T14): notes APPEND onto the order's existing note — never clobber it", async () => {
      primeHeader();

      await service.applyBuyerMergeHeader("ord-1", { notes: "ring bell" }, customerPayload);

      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "ord-1" } }),
      );
      expect(headerData().notes).toBe("Operator: leave at loading dock\nring bell");
    });

    it("REG-B78 (T14): notes on an order with no note are written verbatim (no leading newline)", async () => {
      primeHeader({ notes: null as unknown as string });

      await service.applyBuyerMergeHeader("ord-1", { notes: "  ring bell  " }, customerPayload);

      expect(headerData().notes).toBe("ring bell");
    });

    it("REG-B78 (T14): urgent:false never clears an urgent order — the key is not written at all", async () => {
      // Paired with a notes field on purpose: the update DOES happen, so the
      // claim under test is "no urgent write", not "no write". A mutation to
      // `if (header.urgent !== undefined) data.urgent = header.urgent` would
      // silently downgrade an urgent order on a buyer's non-urgent cart add.
      primeHeader({ urgent: true });

      await service.applyBuyerMergeHeader(
        "ord-1",
        { notes: "one more case", urgent: false },
        customerPayload,
      );

      expect(prisma.order.update).toHaveBeenCalledTimes(1);
      expect(headerData()).not.toHaveProperty("urgent");
    });

    it("REG-B78 (T14): urgent:true sets the flag", async () => {
      primeHeader({ urgent: false });

      await service.applyBuyerMergeHeader("ord-1", { urgent: true }, customerPayload);

      expect(headerData().urgent).toBe(true);
    });

    it("REG-B78 (T14): a provided requestedDeliveryDate is parsed and written", async () => {
      primeHeader();

      await service.applyBuyerMergeHeader(
        "ord-1",
        { requestedDeliveryDate: "2026-09-05" },
        customerPayload,
      );

      expect(headerData().requestedDeliveryDate).toEqual(new Date("2026-09-05"));
    });

    it("REG-B78 (T14): an empty header issues no order write at all", async () => {
      primeHeader();

      await service.applyBuyerMergeHeader(
        "ord-1",
        { notes: "   ", urgent: false, requestedDeliveryDate: undefined },
        customerPayload,
      );

      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it("REG-B78 (T14): a CUSTOMER cannot write the header of an order they do not own", async () => {
      prisma.order.findFirst.mockResolvedValue({ ...OWNED_ORDER, customerId: "cust-someone-else" });
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });

      await expect(
        service.applyBuyerMergeHeader("ord-1", { notes: "ring bell" }, customerPayload),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.order.update).not.toHaveBeenCalled();
    });
  });
});
