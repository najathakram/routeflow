import { regulatedGateOpenProvider } from "./testing/regulated-gate-open-provider";
import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
import { Test } from "@nestjs/testing";
import { OrderTemplatesService } from "./order-templates.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "../orders/orders.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { NotificationsService } from "../notifications/notifications.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { AuditService } from "../audit/audit.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { decrementStockForSale } from "../orders/order-stock";
import { UserRole } from "@prisma/client";
import type { JwtPayload } from "../auth/jwt-payload.interface";

/**
 * B647 + B658: a standing order is written through a bare `prisma.order.create()`, never
 * `OrdersService.create()` — so it skipped BOTH the stock decrement (B647: a cancel then
 * credits back a decrement that never happened, inflating currentStock) and the regulated
 * per-category levy (B658: categoryTaxAmount hardcoded 0, silently under-collected).
 *
 * These specs use the REAL `resolveBuyerLinePrice` (prototype, no `this`), the REAL
 * `computeLineSubtotal`/`computeCategoryTax`, and the REAL `decrementStockForSale` — mocking
 * only the database, the promotion/history loaders, and (where noted) `../orders/order-stock`
 * to assert the exact call, so the money assertions are arithmetic, not mirrors of a stub.
 */
jest.mock("../orders/order-stock", () => ({
  decrementStockForSale: jest.fn().mockResolvedValue(undefined),
}));
const mockDecrementStockForSale = decrementStockForSale as jest.Mock;

// @LeaderCron wraps generateDailyOrders in a Postgres advisory lock (common/cron-lock.ts).
// There is no database here, so the lock is a PASS-THROUGH that still runs the body — same
// mock as order-templates.removed-customer.spec.ts / recurring-invoices.service.spec.ts.
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

describe("OrderTemplatesService — stock decrement + regulated levy on generated orders", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let ordersService: {
    mergeAllPendingForCustomer: jest.Mock;
    loadActivePromotions: jest.Mock;
    getCustomerPriceHistory: jest.Mock;
    resolveBuyerLinePrice: jest.Mock;
  };
  const realResolver = (OrdersService.prototype as any).resolveBuyerLinePrice;

  beforeEach(async () => {
    prisma = createMockPrisma();
    mockDecrementStockForSale.mockClear();
    ordersService = {
      mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
      loadActivePromotions: jest.fn().mockResolvedValue([]),
      getCustomerPriceHistory: jest.fn().mockResolvedValue({}),
      resolveBuyerLinePrice: jest.fn((...args: any[]) => realResolver(...args)),
    };

    const mod = await Test.createTestingModule({
      providers: [
        oversellReaderOffProvider,
        OrderTemplatesService,
        regulatedGateOpenProvider,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: { run: jest.fn((_id, fn) => fn()) } },
        // settings.taxRate is stored as a PERCENT string — "10" is 10%.
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue("10") } },
        { provide: OrdersService, useValue: ordersService },
        {
          provide: AuthorizationGuardService,
          useValue: { checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }) },
        },
        {
          provide: NotificationsService,
          useValue: {
            sendToCustomer: jest.fn().mockResolvedValue(1),
            sendToUser: jest.fn().mockResolvedValue(1),
          },
        },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: SellingRestrictionsService,
          useValue: {
            assertLinesSellable: jest.fn().mockResolvedValue(undefined),
            checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
          },
        },
      ],
    }).compile();
    service = mod.get(OrderTemplatesService);

    prisma.customer.findUnique.mockResolvedValue({ id: "c1", pricingTier: 1 });
    prisma.customerPrice.findMany.mockResolvedValue([]);
    prisma.trackedCategory.findMany.mockResolvedValue([]);
    prisma.order.create.mockImplementation((a: any) => Promise.resolve({ id: "o1", ...a.data }));
  });

  function setTemplate(items: Array<{ productId: string; qty: number; notes?: string | null }>) {
    prisma.orderTemplate.findUnique.mockResolvedValue({
      id: "t1",
      customerId: "c1",
      name: "Weekly",
      isActive: true,
      items,
    });
  }

  // ─── B647: stock decrement ──────────────────────────────────────────────────

  describe("B647 — stock decrement", () => {
    it("decrements stock through the SAME shared decrementStockForSale helper create() uses", async () => {
      prisma.product.findMany.mockResolvedValue([
        { id: "p1", pricePerUnit: 10, unitsPerBox: null, trackedCategoryId: null },
      ]);
      setTemplate([{ productId: "p1", qty: 3, notes: null }]);

      await service.generateOrder("t1");

      expect(mockDecrementStockForSale).toHaveBeenCalledTimes(1);
      const [deps, , stockLines, isStaffRole] = mockDecrementStockForSale.mock.calls[0];
      expect(deps).toEqual(expect.objectContaining({ tenantId: "test-tenant" }));
      expect(stockLines).toEqual([{ id: undefined, position: 0, productId: "p1", qty: 3 }]);
      // An unattended cron run must never abort on insufficient stock — the staff/operator
      // posture (warn + oversell), never the customer/driver hard-block.
      expect(isStaffRole).toBe(true);
    });

    // #1208 review low: this was titled "aggregates one stockLine per product" but used
    // two DIFFERENT products, so it never exercised aggregation at all — the actual
    // per-product fold (qtyByProduct) lives INSIDE decrementStockForSale itself, which
    // this file mocks wholesale. What this level of the stack owns is passing ONE stock
    // line per template line, unfolded, in a SINGLE call — the shared helper folds any
    // repeats. Retitled to say that; a genuine same-product-twice fold is proven by
    // decrementStockForSale's own contract (order-stock.ts's qtyByProduct), exercised
    // unmocked below in "the real decrementStockForSale folds two lines of the same
    // product into one UPDATE".
    it("passes every template line as its own stockLine, all in ONE decrementStockForSale call", async () => {
      prisma.product.findMany.mockResolvedValue([
        { id: "p1", pricePerUnit: 10, unitsPerBox: null, trackedCategoryId: null },
        { id: "p2", pricePerUnit: 5, unitsPerBox: null, trackedCategoryId: null },
      ]);
      setTemplate([
        { productId: "p1", qty: 2, notes: null },
        { productId: "p2", qty: 4, notes: null },
      ]);

      await service.generateOrder("t1");

      expect(mockDecrementStockForSale).toHaveBeenCalledTimes(1);
      const [, , stockLines] = mockDecrementStockForSale.mock.calls[0];
      expect(stockLines).toEqual([
        { id: undefined, position: 0, productId: "p1", qty: 2 },
        { id: undefined, position: 1, productId: "p2", qty: 4 },
      ]);
    });

    // #1208 review item 4: decrementStockForSale is mocked wholesale everywhere else in
    // this file, so nothing here proved the currentStock write it actually produces for
    // the stockLines a generated order hands it. Call the REAL helper directly (not
    // through generateOrder — its own aggregation contract needs no service plumbing)
    // with a minimal fake tx, and assert the exact UPDATE it issues.
    it("the real decrementStockForSale folds two lines of the same product into one UPDATE with the summed qty", async () => {
      const { decrementStockForSale: real } = jest.requireActual("../orders/order-stock");
      const executeRaw = jest.fn().mockResolvedValue(0);
      // B562 PR-2: the decrement is `UPDATE … RETURNING` via $queryRaw; it returns the new counter.
      const queryRaw = jest.fn().mockResolvedValue([{ id: "p1", currentStock: 94 }]);
      const create = jest.fn().mockResolvedValue({ id: "mv-1" });
      const fakeTx = {
        $executeRaw: executeRaw,
        $queryRaw: queryRaw,
        product: {
          findMany: jest.fn().mockResolvedValue([{ id: "p1", name: "Widget", currentStock: 100 }]),
          findFirst: jest.fn().mockResolvedValue({ costingMethod: "AVCO", averageCost: 2 }),
        },
        stockMovement: { create },
      };
      // Two template lines for the SAME product — this is exactly the shape
      // generateOrder's stockLines array can carry (one entry per template line,
      // unfolded); decrementStockForSale must fold them into a single UPDATE row.
      await real(
        { logger: { warn: jest.fn() }, tenantId: "test-tenant" },
        fakeTx,
        [
          { productId: "p1", qty: 2 },
          { productId: "p1", qty: 4 },
        ],
        true,
        { orderId: "o1", notes: "TEMPLATE:t1", performedById: null },
      );

      // $executeRaw = SET LOCAL lock_timeout, then the FOR UPDATE lock; $queryRaw = the aggregated UPDATE … RETURNING.
      expect(executeRaw).toHaveBeenCalledTimes(2);
      expect(queryRaw).toHaveBeenCalledTimes(1);
      const updateValues = queryRaw.mock.calls[0][1]; // first interpolated value: the VALUES row
      // Prisma.sql's join of a single-entry array yields ONE Sql fragment whose own
      // `values` carries [productId, qty] — qty must be the SUM (6), proving the fold,
      // never two separate rows of 2 and 4.
      expect(updateValues.values).toEqual(["p1", 6]);
      // B562 PR-2: ONE SALE row for the folded product, carrying the counter the UPDATE returned.
      expect(create).toHaveBeenCalledTimes(1);
      const row = create.mock.calls[0][0].data;
      expect(row).toMatchObject({
        productId: "p1",
        type: "SALE",
        reference: "ORDER:o1",
        notes: "TEMPLATE:t1",
        performedById: null,
      });
      expect(row.quantity.toString()).toBe("-6");
      expect(row.stockAfter.toString()).toBe("94");
    });

    it("never decrements a line skipped by the regulated license guard", async () => {
      const authGuard = { checkAuthorized: jest.fn() };
      const mod = await Test.createTestingModule({
        providers: [
          oversellReaderOffProvider,
          OrderTemplatesService,
          regulatedGateOpenProvider,
          { provide: PrismaService, useValue: prisma },
          { provide: TenantContextService, useValue: { run: jest.fn((_id, fn) => fn()) } },
          { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue("10") } },
          { provide: OrdersService, useValue: ordersService },
          { provide: AuthorizationGuardService, useValue: authGuard },
          {
            provide: NotificationsService,
            useValue: {
              sendToCustomer: jest.fn().mockResolvedValue(1),
              sendToUser: jest.fn().mockResolvedValue(1),
            },
          },
          { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
          {
            provide: SellingRestrictionsService,
            useValue: {
              assertLinesSellable: jest.fn().mockResolvedValue(undefined),
              checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
            },
          },
        ],
      }).compile();
      const gatedService = mod.get(OrderTemplatesService);

      authGuard.checkAuthorized.mockResolvedValue({
        blocked: [{ trackedCategoryId: "cat-tob", categoryName: "Tobacco", reason: "NO_AUTH" }],
      });
      prisma.product.findMany.mockResolvedValue([
        { id: "p-tob", pricePerUnit: 10, unitsPerBox: null, trackedCategoryId: "cat-tob" },
        { id: "p-std", pricePerUnit: 5, unitsPerBox: null, trackedCategoryId: null },
      ]);
      prisma.user.findMany.mockResolvedValue([]);
      setTemplate([
        { productId: "p-tob", qty: 2, notes: null },
        { productId: "p-std", qty: 3, notes: null },
      ]);

      await gatedService.generateOrder("t1");

      const [, , stockLines] = mockDecrementStockForSale.mock.calls[0];
      expect(stockLines).toEqual([{ id: undefined, position: 0, productId: "p-std", qty: 3 }]);
    });
  });

  // ─── B658: regulated per-category levy ──────────────────────────────────────

  describe("B658 — regulated per-category levy", () => {
    it("folds a PERCENT_OF_SALE category levy into categoryTaxAmount and the order total", async () => {
      prisma.product.findMany.mockResolvedValue([
        { id: "p1", pricePerUnit: 10, unitsPerBox: null, trackedCategoryId: "cat-1" },
      ]);
      prisma.trackedCategory.findMany.mockResolvedValue([
        { id: "cat-1", taxType: "PERCENT_OF_SALE", rate: 0.05, priceIncludesTax: false },
      ]);
      setTemplate([{ productId: "p1", qty: 2, notes: null }]);

      await service.generateOrder("t1");

      const createArg = prisma.order.create.mock.calls[0][0].data;
      const line = createArg.lineItems.create[0];
      // subtotal = 10 * 2 = 20; category levy = 20 * 0.05 = 1; regular tax = 20 * 0.10 = 2.
      expect(line.subtotal).toBe(20);
      expect(line.categoryTaxAmount).toBe(1);
      expect(createArg.subtotal).toBe(20);
      expect(createArg.tax).toBe(2);
      expect(createArg.total).toBe(23); // 20 + 2 (regular tax) + 1 (category levy)
    });

    it("folds an EXCISE_PER_UNIT category levy basis-priced on true PIECE qty, not selling units", async () => {
      prisma.product.findMany.mockResolvedValue([
        { id: "p1", pricePerUnit: 10, unitsPerBox: 12, trackedCategoryId: "cat-1" },
      ]);
      prisma.trackedCategory.findMany.mockResolvedValue([
        { id: "cat-1", taxType: "EXCISE_PER_UNIT", rate: 0.5, priceIncludesTax: false },
      ]);
      // qty:2 boxes of 12 -> qtyPieces 24 for the levy basis (a template line is never split
      // into boxes/pieces — see the "box-unaware boxed line" comment in the service).
      setTemplate([{ productId: "p1", qty: 2, notes: null }]);

      await service.generateOrder("t1");

      const line = prisma.order.create.mock.calls[0][0].data.lineItems.create[0];
      expect(line.categoryTaxAmount).toBe(12); // 24 pieces * $0.50
    });

    it("charges no levy for a plain (non-regulated) line — categoryTaxAmount 0, total unchanged", async () => {
      prisma.product.findMany.mockResolvedValue([
        { id: "p1", pricePerUnit: 10, unitsPerBox: null, trackedCategoryId: null },
      ]);
      setTemplate([{ productId: "p1", qty: 1, notes: null }]);

      await service.generateOrder("t1");

      const createArg = prisma.order.create.mock.calls[0][0].data;
      expect(createArg.lineItems.create[0].categoryTaxAmount).toBe(0);
      expect(createArg.total).toBe(11); // 10 + 1 (10% regular tax) + 0
    });
  });

  // ─── #1208 review lows ───────────────────────────────────────────────────────

  describe("#1208 review LOW-MED: isStaffRole threads from the actual caller, not a hardcoded true", () => {
    it("generateOrderForUser as OPERATOR keeps the warn-and-oversell posture", async () => {
      prisma.product.findMany.mockResolvedValue([
        { id: "p1", pricePerUnit: 10, unitsPerBox: null, trackedCategoryId: null },
      ]);
      setTemplate([{ productId: "p1", qty: 3, notes: null }]);
      const operator: JwtPayload = { sub: "u-op", role: UserRole.OPERATOR } as JwtPayload;

      await service.generateOrderForUser("t1", operator);

      const [, , , isStaffRole] = mockDecrementStockForSale.mock.calls[0];
      expect(isStaffRole).toBe(true);
    });

    it("generateOrderForUser as CUSTOMER (buyer 'Reorder' via the operator portal) gets the hard block", async () => {
      prisma.product.findMany.mockResolvedValue([
        { id: "p1", pricePerUnit: 10, unitsPerBox: null, trackedCategoryId: null },
      ]);
      prisma.customer.findFirst.mockResolvedValue({ id: "c1" }); // owns template t1 (customerId: "c1")
      setTemplate([{ productId: "p1", qty: 3, notes: null }]);
      const customer: JwtPayload = { sub: "u-cust", role: UserRole.CUSTOMER } as JwtPayload;

      await service.generateOrderForUser("t1", customer);

      const [, , , isStaffRole] = mockDecrementStockForSale.mock.calls[0];
      // A buyer's own "Reorder" gets the SAME hard block their checkout (orders.service.ts
      // create()) would give them — never the operator/cron warn-and-oversell.
      expect(isStaffRole).toBe(false);
    });

    it("the unattended cron path (generateDailyOrders) keeps isStaffRole=true regardless of caller threading", async () => {
      prisma.tenant.findMany.mockResolvedValue([{ id: "test-tenant" }]);
      prisma.orderTemplate.count.mockResolvedValue(0);
      prisma.order.findFirst.mockResolvedValue(null); // not already generated today
      const template = { id: "t1", customerId: "c1", name: "Weekly", isActive: true, items: [] };
      prisma.orderTemplate.findMany.mockResolvedValue([template]);
      // Spy on the shared private method itself (not the full price/tax/stock pipeline
      // exercised elsewhere in this file) — this test's only claim is which isStaffRole
      // value the cron loop passes down, not the whole generate flow again.
      const spy = jest
        .spyOn(service as any, "createOrderFromTemplate")
        .mockResolvedValue({ id: "o1" });

      await service.generateDailyOrders();

      expect(spy).toHaveBeenCalledTimes(1);
      const [, isStaffRole] = spy.mock.calls[0];
      expect(isStaffRole).toBe(true);
    });
  });

  describe("#1208 review LOW: the generated total is guarded by assertMoneyInvariantsOrThrow, like create()", () => {
    it("refuses to generate an order whose computed total would be negative", async () => {
      // A negative pricePerUnit is bad data, not a real scenario — but it is exactly the
      // kind of computed-total corruption the guard exists to catch before anything is
      // written, mirroring create()'s own money-invariant check (orders.service.ts
      // :2164-2170) rather than trusting the arithmetic above it.
      prisma.product.findMany.mockResolvedValue([
        { id: "p1", pricePerUnit: -10, unitsPerBox: null, trackedCategoryId: null },
      ]);
      setTemplate([{ productId: "p1", qty: 1, notes: null }]);

      await expect(service.generateOrder("t1")).rejects.toMatchObject({
        response: expect.objectContaining({ code: "MONEY_INVARIANT" }),
      });
      expect(prisma.order.create).not.toHaveBeenCalled();
      expect(mockDecrementStockForSale).not.toHaveBeenCalled();
    });
  });

  // SA-767 r-note 3 (b): the generation tx is inside retryStockTx. A lock wait that gave up (55P03) on
  // attempt 1 re-runs the WHOLE tx (order write + decrement): Postgres rolled the first order back, so
  // the committed attempts are the ones that did not throw.
  describe("SA-767 r-note 3 (b) — the generation tx is inside retryStockTx", () => {
    const lockTimeout = () =>
      Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
    const arrange = () => {
      prisma.product.findMany.mockResolvedValue([
        { id: "p1", pricePerUnit: 10, unitsPerBox: null, trackedCategoryId: null },
      ]);
      setTemplate([{ productId: "p1", qty: 3, notes: null }]);
    };
    /** Writes of a tx attempt that threw are rolled back: count only the attempts that committed. */
    const committedOrders = () => {
      const real = prisma.tenantTransaction.getMockImplementation()!;
      let rolledBack = 0;
      prisma.tenantTransaction.mockImplementation(async (fn: any, opts?: any) => {
        const before = prisma.order.create.mock.calls.length;
        try {
          return await real(fn, opts);
        } catch (e) {
          rolledBack += prisma.order.create.mock.calls.length - before;
          throw e;
        }
      });
      return () => prisma.order.create.mock.calls.length - rolledBack;
    };

    it("a 55P03 from the decrement re-runs the whole tx; exactly one order commits", async () => {
      arrange();
      mockDecrementStockForSale.mockRejectedValueOnce(lockTimeout());
      const committed = committedOrders();

      await expect(service.generateOrder("t1")).resolves.toMatchObject({ id: "o1" });

      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(2);
      expect(mockDecrementStockForSale).toHaveBeenCalledTimes(2);
      expect(committed()).toBe(1);
    });

    it("a 55P03 on every attempt is the coded 503 LOCK_UNAVAILABLE; no order commits", async () => {
      arrange();
      mockDecrementStockForSale.mockRejectedValue(lockTimeout());
      const committed = committedOrders();

      await expect(service.generateOrder("t1")).rejects.toMatchObject({
        status: 503,
        response: { code: "LOCK_UNAVAILABLE" },
      });

      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(3);
      expect(committed()).toBe(0);
      mockDecrementStockForSale.mockResolvedValue(undefined);
    });

    it("an unrelated error propagates unchanged after ONE attempt", async () => {
      arrange();
      const boom = new Error("boom");
      mockDecrementStockForSale.mockRejectedValueOnce(boom);

      await expect(service.generateOrder("t1")).rejects.toBe(boom);
      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    });
  });
});
