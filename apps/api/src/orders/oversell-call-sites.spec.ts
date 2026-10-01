// The harness FIRST: it jest.mock()s modules that orders.service also imports.
import {
  buildOversellOrders,
  buyer,
  driver,
  firstOrder,
  operator,
  stockTx,
  tenantAdmin,
  TENANT,
} from "./testing/oversell-harness";
import { ConflictException } from "@nestjs/common";

/**
 * WS9 call-site contract (RED until the call-site PR wires it): OrdersService calls
 * `resolveOversellAllowed(reader, { tenantId, role, source, customerId })` EXACTLY ONCE per request,
 * BEFORE the transaction opens (so before any FOR UPDATE), then hands only the resolved BOOLEAN to
 * `decrementStockForSale` / `settleStockForEdit`. Seams: `resolveOversellAllowed` (spy over the real
 * one), the injected `PolicyOversellReader.read`, the mocked prisma `tenantTransaction` and the
 * order-stock functions (spies; `useRealStock()` runs the real ones for the behaviour matrix).
 *
 * Sites driven here: create (staff + buyer), DRAFT->PENDING promotion, operator + buyer edit.
 * The at-door site and the template/buyer-controller sites are in their own specs.
 */

const PRODUCT = {
  id: "prod-1",
  name: "Widget",
  unit: "ea",
  pricePerUnit: 10,
  unitsPerBox: null,
  category: null,
  trackedCategoryId: null,
  trackedSubcategoryId: null,
  isActive: true,
};

type H = Awaited<ReturnType<typeof buildOversellOrders>>;

/** The create() arrangement of orders.create-units.spec.ts, with a locked-row tx (`stockTx`). */
function arrangeCreate(h: H, stock = { v: 5 }) {
  const { prisma } = h;
  prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
  prisma.customer.findUnique.mockResolvedValue({
    id: "cust-1",
    pricingTier: 1,
    user: { status: "ACTIVE" },
    deletedAt: null,
  });
  prisma.product.findMany.mockResolvedValue([PRODUCT]);
  prisma.order.create.mockResolvedValue({
    id: "ord-new",
    customerId: "cust-1",
    orderNumber: "x",
    total: 0,
    urgent: false,
    createdAt: new Date(),
    customer: { id: "cust-1", businessName: "Acme" },
    lineItems: [],
  });
  const t = stockTx(prisma as never, stock);
  (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(t.tx));
  return { stock, ...t };
}

const createDto = (qty: number) => ({
  customerId: "cust-1",
  items: [{ productId: "prod-1", qty }],
});

/** resolve ran strictly before the transaction opened and before anything inside it. */
function expectResolvedBeforeTransaction(
  h: H,
  tx?: { $executeRaw: jest.Mock; $queryRaw: jest.Mock },
) {
  const resolveAt = h.resolve.mock.invocationCallOrder[0];
  expect(resolveAt).toBeDefined();
  expect(resolveAt).toBeLessThan(firstOrder(h.prisma.tenantTransaction as jest.Mock));
  if (tx)
    expect(resolveAt).toBeLessThan(firstOrder(tx.$executeRaw, tx.$queryRaw, h.decrement, h.settle));
}

describe("create(): resolveOversellAllowed once, before the transaction", () => {
  it.each([
    ["OPERATOR", operator],
    ["TENANT_ADMIN", tenantAdmin],
  ])(
    "%s -> source staff_entry, role passed, one call, boolean true reaches the stock path",
    async (_n, user) => {
      const h = await buildOversellOrders("off");
      const a = arrangeCreate(h);
      await h.service.create(createDto(2) as never, user as never);

      expect(h.resolve).toHaveBeenCalledTimes(1);
      expect(h.resolve).toHaveBeenCalledWith(
        h.reader,
        expect.objectContaining({ tenantId: TENANT, role: user.role, source: "staff_entry" }),
      );
      expectResolvedBeforeTransaction(h, a.tx);
      expect(h.decrement).toHaveBeenCalledTimes(1);
      const args = h.decrement.mock.calls[0];
      expect(args[3]).toBe(true);
      expect(args).not.toContain(h.reader);
      expect(h.read).not.toHaveBeenCalled(); // staff never read the policy
    },
  );

  it.each([
    ["backorder", true],
    ["off", false],
  ])(
    "CUSTOMER (policy %s) -> source buyer with the buyer's customerId, boolean %s reaches decrementStockForSale",
    async (policy, want) => {
      const h = await buildOversellOrders(policy);
      const a = arrangeCreate(h);
      await h.service.create({ items: [{ productId: "prod-1", qty: 2 }] } as never, buyer as never);

      expect(h.resolve).toHaveBeenCalledTimes(1);
      expect(h.resolve).toHaveBeenCalledWith(
        h.reader,
        expect.objectContaining({
          tenantId: TENANT,
          role: "CUSTOMER",
          source: "buyer",
          customerId: "cust-1",
        }),
      );
      expect(h.read).toHaveBeenCalledTimes(1);
      expect(h.read).toHaveBeenCalledWith({ tenantId: TENANT, customerId: "cust-1" });
      expectResolvedBeforeTransaction(h, a.tx);
      const args = h.decrement.mock.calls[0];
      expect(args[3]).toBe(want);
      expect(typeof args[3]).toBe("boolean");
      expect(args).not.toContain(h.reader);
    },
  );

  it("a staff DRAFT create (no stock path) never reads the policy and never reaches the stock helper", async () => {
    const h = await buildOversellOrders("backorder");
    arrangeCreate(h);
    await h.service.create({ ...createDto(2), status: "DRAFT" } as never, operator as never);
    expect(h.decrement).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
  });
});

describe("DRAFT -> PENDING promotion: resolveOversellAllowed once, before the transaction", () => {
  const draft = {
    id: "ord-1",
    customerId: "cust-1",
    tenantId: TENANT,
    orderNumber: "ORD-1",
    status: "DRAFT",
    orderDate: null as Date | null,
    routeRunId: null,
    routeRunStopId: null,
    customer: { businessName: "Acme" },
    lineItems: [],
  };
  const line = { productId: "prod-1", qty: 2, trackedCategoryId: null };

  async function arrangePromotion() {
    const h = await buildOversellOrders("backorder");
    h.prisma.order.findUnique.mockResolvedValue({ ...draft });
    h.prisma.orderItem.findMany.mockResolvedValue([line]);
    h.prisma.product.findMany.mockResolvedValue([
      { id: "prod-1", name: "Widget", currentStock: 100, trackedCategoryId: null },
    ]);
    h.prisma.order.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.order.findUniqueOrThrow.mockResolvedValue({ ...draft, status: "PENDING" });
    return h;
  }

  it.each([
    ["OPERATOR", operator],
    ["TENANT_ADMIN", tenantAdmin],
  ])(
    "%s promotes: source promotion, one call, true reaches decrementStockForSale",
    async (_n, user) => {
      const h = await arrangePromotion();
      await h.service.changeStatus("ord-1", { status: "PENDING" as never }, user as never);

      expect(h.resolve).toHaveBeenCalledTimes(1);
      expect(h.resolve).toHaveBeenCalledWith(
        h.reader,
        expect.objectContaining({ tenantId: TENANT, role: user.role, source: "promotion" }),
      );
      expectResolvedBeforeTransaction(h);
      expect(h.decrement).toHaveBeenCalledTimes(1);
      const args = h.decrement.mock.calls[0];
      expect(args[3]).toBe(true);
      expect(args[4]).toMatchObject({ orderId: "ord-1", notes: "PROMOTE" });
      expect(args).not.toContain(h.reader);
      expect(h.read).not.toHaveBeenCalled(); // staff short-circuit
    },
  );

  it("a non-promotion transition (cancel a DRAFT) reads no policy and decrements nothing", async () => {
    const h = await arrangePromotion();
    h.prisma.order.findFirst.mockResolvedValue({ id: "ord-1", status: "DRAFT", orderNumber: "1" });
    h.prisma.invoice.findMany.mockResolvedValue([]);
    await h.service.changeStatus("ord-1", { status: "CANCELLED" as never }, operator as never);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.decrement).not.toHaveBeenCalled();
  });
});

describe("edit (updateOrderItems -> settleStockForEdit): resolveOversellAllowed once, before the transaction", () => {
  const line = {
    id: "li-1",
    orderId: "ord-1",
    productId: "prod-1",
    qty: 2,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    unitPrice: 5,
    subtotal: 10,
    status: "PENDING",
    priceType: "STANDARD",
    originalPrice: null,
    invoicedQty: 0,
    deliveredQty: 0,
    promoFreeUnits: null,
    unitLabel: null,
    notes: null,
    overrideReason: null,
    position: 0,
  };
  const order = (status: string) => ({
    id: "ord-1",
    tenantId: TENANT,
    customerId: "cust-1",
    status,
    routeRun: null,
    shippingFee: 0,
    lineItems: [line],
  });

  async function arrangeEdit(policy: string, status: string) {
    const h = await buildOversellOrders(policy);
    const { prisma } = h;
    prisma.order.findUnique.mockResolvedValue(order(status));
    prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    prisma.customerPrice.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([{ ...PRODUCT, pricePerUnit: 5, unitsPerBox: null }]);
    prisma.deliveryMutation.count.mockResolvedValue(0);
    prisma.orderItem.findMany.mockImplementation(async (args: any) =>
      args?.where?.status ? [line] : [line],
    );
    return h;
  }

  it.each([["OPERATOR", operator, "CONFIRMED"]])(
    "%s edit: source edit, one call, true reaches settleStockForEdit's opts",
    async (_n, user, status) => {
      const h = await arrangeEdit("off", status);
      await h.service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-1", action: "UPDATE", qty: 5 }] } as never,
        user as never,
      );

      expect(h.resolve).toHaveBeenCalledTimes(1);
      expect(h.resolve).toHaveBeenCalledWith(
        h.reader,
        expect.objectContaining({ tenantId: TENANT, role: user.role, source: "edit" }),
      );
      expectResolvedBeforeTransaction(h);
      expect(h.settle).toHaveBeenCalledTimes(1);
      const args = h.settle.mock.calls[0]; // (deps, db, order, held, final, user, event, opts)
      expect(args[7]).toEqual({ allowOversell: true });
      expect(args).not.toContain(h.reader);
      expect(h.read).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["backorder", true],
    ["off", false],
  ])(
    "CUSTOMER edit of its own PENDING order (policy %s): source edit + customerId, boolean %s",
    async (policy, want) => {
      const h = await arrangeEdit(policy, "PENDING");
      await h.service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-1", qty: 5 }], replaceAll: true } as never,
        buyer as never,
      );

      expect(h.resolve).toHaveBeenCalledTimes(1);
      expect(h.resolve).toHaveBeenCalledWith(
        h.reader,
        expect.objectContaining({
          tenantId: TENANT,
          role: "CUSTOMER",
          source: "edit",
          customerId: "cust-1",
        }),
      );
      expect(h.read).toHaveBeenCalledTimes(1);
      expectResolvedBeforeTransaction(h);
      expect(h.settle.mock.calls[0][7]).toEqual({ allowOversell: want });
    },
  );
});

describe("behaviour matrix through create() with the REAL order-stock and the REAL resolver (C2)", () => {
  it("policy off + CUSTOMER 6 vs 5 -> coded INSUFFICIENT_STOCK 409, stock untouched, no SALE row", async () => {
    const h = await buildOversellOrders("off");
    h.useRealStock();
    const a = arrangeCreate(h, { v: 5 });
    const err = await h.service
      .create({ items: [{ productId: "prod-1", qty: 6 }] } as never, buyer as never)
      .then(
        () => null,
        (e) => e,
      );
    expect(err).toBeInstanceOf(ConflictException);
    // The coded body (`code: INSUFFICIENT_STOCK`) arrives with #2871; both shapes carry the readable message.
    expect(String((err.getResponse() as { message?: string }).message ?? err.message)).toMatch(
      /Insufficient stock/,
    );
    expect(a.stock.v).toBe(5);
    expect(a.movements).toHaveLength(0);
  });

  it("policy backorder + CUSTOMER 6 vs 5 -> succeeds, stock -1, one SALE movement", async () => {
    const h = await buildOversellOrders("backorder");
    h.useRealStock();
    const a = arrangeCreate(h, { v: 5 });
    await h.service.create({ items: [{ productId: "prod-1", qty: 6 }] } as never, buyer as never);
    expect(a.stock.v).toBe(-1);
    expect(a.movements).toHaveLength(1);
    expect(a.movements[0]).toMatchObject({
      type: "SALE",
      reference: expect.stringContaining("ORDER:"),
    });
  });

  it("tenant backorder + CUSTOMER-scope off for THIS customer -> 409 (customer layer wins)", async () => {
    const h = await buildOversellOrders((a) => (a.customerId === "cust-1" ? "off" : "backorder"));
    h.useRealStock();
    const a = arrangeCreate(h, { v: 5 });
    await expect(
      h.service.create({ items: [{ productId: "prod-1", qty: 6 }] } as never, buyer as never),
    ).rejects.toMatchObject({ response: { message: expect.stringMatching(/Insufficient stock/) } });
    expect(a.stock.v).toBe(5);
  });

  it("DRIVER never oversells and never reads the policy, even with the policy on", async () => {
    const h = await buildOversellOrders("backorder");
    h.useRealStock();
    const a = arrangeCreate(h, { v: 5 });
    await expect(h.service.create(createDto(6) as never, driver as never)).rejects.toMatchObject({
      response: { message: expect.stringMatching(/Insufficient stock/) },
    });
    expect(h.read).not.toHaveBeenCalled();
    expect(a.stock.v).toBe(5);
  });

  it.each([
    ["off", operator],
    ["backorder", operator],
    ["off", tenantAdmin],
  ])(
    "staff always oversell (policy %s, unchanged): stock -1, one SALE row, policy never read",
    async (policy, user) => {
      const h = await buildOversellOrders(policy);
      h.useRealStock();
      const a = arrangeCreate(h, { v: 5 });
      await h.service.create(createDto(6) as never, user as never);
      expect(a.stock.v).toBe(-1);
      expect(a.movements).toHaveLength(1);
      expect(h.read).not.toHaveBeenCalled();
    },
  );
});
