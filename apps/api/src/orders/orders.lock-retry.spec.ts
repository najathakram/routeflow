// The harness FIRST: it jest.mock()s modules that orders.service also imports.
import { buildOversellOrders, operator, stockTx, TENANT } from "./testing/oversell-harness";
import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";

/**
 * SA-767 r-note 3 (b): the order sale sites run their stock transaction inside `retryStockTx`. A lock
 * wait that gave up (55P03) or a tx budget that expired (P2028) on attempt 1 re-runs the WHOLE tx; the
 * failed attempt is rolled back (modelled below by undoing its writes), so exactly one attempt's
 * writes commit and the request answers 2xx. A lock error on EVERY attempt is the coded 503
 * LOCK_UNAVAILABLE with nothing committed; an unrelated error propagates after ONE attempt.
 */
const lockTimeout = () =>
  Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
const txTimeout = () => Object.assign(new Error("Transaction API error"), { code: "P2028" });

type H = Awaited<ReturnType<typeof buildOversellOrders>>;

/**
 * Postgres rolls back an attempt that threw: undo its recorded writes. `watch` are the write mocks to
 * tally; `undo` restores any state the fake tx mutated (stock counter, movement log).
 */
function emulateRollback(h: H, watch: jest.Mock[], undo?: () => () => void) {
  const real = (h.prisma.tenantTransaction as jest.Mock).getMockImplementation()!;
  const rolledBack = watch.map(() => 0);
  (h.prisma.tenantTransaction as jest.Mock).mockImplementation(async (fn: any, opts?: any) => {
    const before = watch.map((m) => m.mock.calls.length);
    const restore = undo?.();
    try {
      return await real(fn, opts);
    } catch (e) {
      watch.forEach((m, i) => (rolledBack[i] += m.mock.calls.length - before[i]));
      restore?.();
      throw e;
    }
  });
  return (m: jest.Mock) => m.mock.calls.length - rolledBack[watch.indexOf(m)];
}

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
  kind: "STANDARD",
  portalVisible: true,
  parent: null,
};

describe("orders.create: stock tx inside retryStockTx", () => {
  function arrangeCreate(h: H, stock = { v: 5 }) {
    const { prisma } = h;
    h.useRealStock();
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
    const committed = emulateRollback(h, [prisma.order.create as jest.Mock], () => {
      const v = stock.v;
      const n = t.movements.length;
      return () => {
        stock.v = v;
        t.movements.length = n;
      };
    });
    return { stock, committed, ...t };
  }
  const dto = { customerId: "cust-1", items: [{ productId: "prod-1", qty: 2 }] };

  it.each([
    ["55P03", lockTimeout],
    ["P2028", txTimeout],
  ])(
    "a %s after the stock decrement re-runs the whole tx: one order, stock down once",
    async (_n, mk) => {
      const h = await buildOversellOrders("off");
      const a = arrangeCreate(h);
      (h.prisma.order.create as jest.Mock).mockRejectedValueOnce(mk());

      const out = await h.service.create(dto as never, operator as never);

      expect(out).toMatchObject({ id: "ord-new" });
      expect(h.prisma.tenantTransaction).toHaveBeenCalledTimes(2);
      expect(a.committed(h.prisma.order.create as jest.Mock)).toBe(1);
      expect(a.stock.v).toBe(3); // 5 - 2, once
      expect(a.movements).toHaveLength(1);
      expect(h.resolve).toHaveBeenCalledTimes(1); // the policy is resolved once, outside the retried tx
    },
  );

  it("a 55P03 on EVERY attempt is the coded 503 LOCK_UNAVAILABLE; no order, stock untouched", async () => {
    const h = await buildOversellOrders("off");
    const a = arrangeCreate(h);
    (h.prisma.order.create as jest.Mock).mockRejectedValue(lockTimeout());

    const err: any = await h.service.create(dto as never, operator as never).catch((e) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.getResponse()).toMatchObject({ code: "LOCK_UNAVAILABLE" });
    expect(h.prisma.tenantTransaction).toHaveBeenCalledTimes(3);
    expect(a.committed(h.prisma.order.create as jest.Mock)).toBe(0);
    expect(a.stock.v).toBe(5);
    expect(a.movements).toHaveLength(0);
  });

  it("an unrelated error propagates unchanged after ONE attempt (not a 503)", async () => {
    const h = await buildOversellOrders("off");
    arrangeCreate(h);
    const boom = new BadRequestException("nope");
    (h.prisma.order.create as jest.Mock).mockRejectedValue(boom);

    await expect(h.service.create(dto as never, operator as never)).rejects.toBe(boom);
    expect(h.prisma.tenantTransaction).toHaveBeenCalledTimes(1);
  });

  it("the P2002 order-number retry is unchanged: retried up to 3 times, then the raw P2002 (not a 503)", async () => {
    const h = await buildOversellOrders("off");
    arrangeCreate(h);
    const dup = Object.assign(new Error("Unique constraint"), { code: "P2002" });
    (h.prisma.order.create as jest.Mock).mockRejectedValue(dup);

    await expect(h.service.create(dto as never, operator as never)).rejects.toBe(dup);
    expect(h.prisma.tenantTransaction).toHaveBeenCalledTimes(3);
  });

  it("a P2002 then success still lands one order (the order-number loop wraps the lock retry)", async () => {
    const h = await buildOversellOrders("off");
    const a = arrangeCreate(h);
    const dup = Object.assign(new Error("Unique constraint"), { code: "P2002" });
    (h.prisma.order.create as jest.Mock).mockRejectedValueOnce(dup);

    await expect(h.service.create(dto as never, operator as never)).resolves.toMatchObject({
      id: "ord-new",
    });
    expect(h.prisma.tenantTransaction).toHaveBeenCalledTimes(2);
    expect(a.committed(h.prisma.order.create as jest.Mock)).toBe(1);
    expect(a.stock.v).toBe(3);
  });
});

describe("DRAFT -> PENDING promotion: stock tx inside retryStockTx", () => {
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
  async function arrange() {
    const h = await buildOversellOrders("backorder");
    h.prisma.order.findUnique.mockResolvedValue({ ...draft });
    h.prisma.orderItem.findMany.mockResolvedValue([
      { productId: "prod-1", qty: 2, trackedCategoryId: null },
    ]);
    h.prisma.product.findMany.mockResolvedValue([
      { id: "prod-1", name: "Widget", currentStock: 100, trackedCategoryId: null },
    ]);
    h.prisma.order.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.order.findUniqueOrThrow.mockResolvedValue({ ...draft, status: "PENDING" });
    return h;
  }

  it("a 55P03 from the decrement re-runs the whole tx (claim + decrement) and the promotion lands once", async () => {
    const h = await arrange();
    h.decrement.mockRejectedValueOnce(lockTimeout());
    const committed = emulateRollback(h, [h.prisma.order.updateMany as jest.Mock]);

    const out = await h.service.changeStatus(
      "ord-1",
      { status: "PENDING" as never },
      operator as never,
    );

    expect(out).toMatchObject({ status: "PENDING" });
    expect(h.prisma.tenantTransaction).toHaveBeenCalledTimes(2);
    expect(committed(h.prisma.order.updateMany as jest.Mock)).toBe(1);
    expect(h.decrement).toHaveBeenCalledTimes(2); // attempt 1 rolled back with its claim
  });

  it("a 55P03 on every attempt is the coded 503; the claim never commits", async () => {
    const h = await arrange();
    h.decrement.mockRejectedValue(lockTimeout());
    const committed = emulateRollback(h, [h.prisma.order.updateMany as jest.Mock]);

    await expect(
      h.service.changeStatus("ord-1", { status: "PENDING" as never }, operator as never),
    ).rejects.toMatchObject({ response: { code: "LOCK_UNAVAILABLE" }, status: 503 });
    expect(h.prisma.tenantTransaction).toHaveBeenCalledTimes(3);
    expect(committed(h.prisma.order.updateMany as jest.Mock)).toBe(0);
  });

  it("an unrelated error propagates after ONE attempt", async () => {
    const h = await arrange();
    const boom = new BadRequestException("nope");
    h.decrement.mockRejectedValue(boom);
    await expect(
      h.service.changeStatus("ord-1", { status: "PENDING" as never }, operator as never),
    ).rejects.toBe(boom);
    expect(h.prisma.tenantTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("cancel (changeStatus -> CANCELLED): the unwind tx inside retryStockTx", () => {
  const PENDING = {
    id: "ord-1",
    customerId: "cust-1",
    tenantId: TENANT,
    orderNumber: "ORD-123",
    status: "PENDING",
    routeRunId: null,
    routeRunStopId: null,
    total: 16.47,
    customer: { businessName: "Acme" },
  };
  async function arrange() {
    const h = await buildOversellOrders("off");
    const { prisma } = h;
    prisma.order.findUnique.mockResolvedValue(PENDING);
    prisma.order.findFirst.mockResolvedValue(PENDING);
    prisma.order.update.mockResolvedValue({ ...PENDING, status: "CANCELLED" });
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.invoice.findMany.mockResolvedValue([
      { id: "s1", invoiceNumber: "INV-2", status: "SENT", total: 60, payments: [] },
    ]);
    prisma.orderItem.findMany.mockResolvedValue([]);
    return h;
  }
  const release = (h: H) => (h.service as any).creditNotes.releaseOrderCreditsInTx as jest.Mock;

  it("a 55P03 after the stock credit re-runs the whole unwind; the cancel commits once", async () => {
    const h = await arrange();
    release(h).mockRejectedValueOnce(lockTimeout());
    const committed = emulateRollback(h, [
      h.prisma.order.updateMany as jest.Mock,
      h.prisma.orderItem.updateMany as jest.Mock,
    ]);

    await h.service.changeStatus("ord-1", { status: "CANCELLED" as never }, operator as never);

    expect(h.prisma.tenantTransaction).toHaveBeenCalledTimes(2);
    expect(h.settle).toHaveBeenCalledTimes(2); // attempt 1's credit rolled back with its tx
    expect(committed(h.prisma.order.updateMany as jest.Mock)).toBe(1);
    expect(committed(h.prisma.orderItem.updateMany as jest.Mock)).toBe(1);
  });

  it("a 55P03 on every attempt is the coded 503; nothing commits", async () => {
    const h = await arrange();
    release(h).mockRejectedValue(lockTimeout());
    const committed = emulateRollback(h, [
      h.prisma.order.updateMany as jest.Mock,
      h.prisma.orderItem.updateMany as jest.Mock,
    ]);

    const err: any = await h.service
      .changeStatus("ord-1", { status: "CANCELLED" as never }, operator as never)
      .catch((e) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.getResponse()).toMatchObject({ code: "LOCK_UNAVAILABLE" });
    expect(h.prisma.tenantTransaction).toHaveBeenCalledTimes(3);
    expect(committed(h.prisma.orderItem.updateMany as jest.Mock)).toBe(0);
  });

  it("an unrelated error propagates unchanged after ONE attempt", async () => {
    const h = await arrange();
    const boom = new Error("boom");
    release(h).mockRejectedValue(boom);
    await expect(
      h.service.changeStatus("ord-1", { status: "CANCELLED" as never }, operator as never),
    ).rejects.toBe(boom);
    expect(h.prisma.tenantTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("edit (updateOrderItems): the edit tx inside retryStockTx, for a plain edit too", () => {
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
  async function arrange() {
    const h = await buildOversellOrders("off");
    const { prisma } = h;
    prisma.order.findUnique.mockResolvedValue({
      id: "ord-1",
      tenantId: TENANT,
      customerId: "cust-1",
      status: "CONFIRMED",
      routeRun: null,
      shippingFee: 0,
      lineItems: [line],
    });
    prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    prisma.customerPrice.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([{ ...PRODUCT, pricePerUnit: 5 }]);
    prisma.deliveryMutation.count.mockResolvedValue(0);
    prisma.orderItem.findMany.mockResolvedValue([line]);
    return h;
  }
  const edit = (h: H) =>
    h.service.updateOrderItems(
      "ord-1",
      { items: [{ id: "li-1", action: "UPDATE", qty: 5 }] } as never,
      operator as never,
    );

  it("a 55P03 from the settle re-runs the whole edit tx; the header write commits once", async () => {
    const clean = await arrange();
    await edit(clean);
    const cleanWrites = (clean.prisma.order.update as jest.Mock).mock.calls.length;
    const h = await arrange();
    h.settle.mockRejectedValueOnce(lockTimeout());
    const committed = emulateRollback(h, [h.prisma.order.update as jest.Mock]);

    await edit(h);

    expect(h.settle).toHaveBeenCalledTimes(2); // attempt 1 rolled back, attempt 2 committed
    expect(committed(h.prisma.order.update as jest.Mock)).toBe(cleanWrites); // one attempt's writes
    expect(h.resolve).toHaveBeenCalledTimes(1); // outside the retried tx
  });

  it("a 55P03 on every attempt is the coded 503; nothing commits", async () => {
    const h = await arrange();
    h.settle.mockRejectedValue(lockTimeout());
    const committed = emulateRollback(h, [h.prisma.order.update as jest.Mock]);

    const err: any = await edit(h).catch((e) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.getResponse()).toMatchObject({ code: "LOCK_UNAVAILABLE" });
    expect(h.settle).toHaveBeenCalledTimes(3);
    expect(committed(h.prisma.order.update as jest.Mock)).toBe(0);
  });

  it("an unrelated error propagates unchanged after ONE attempt", async () => {
    const h = await arrange();
    const boom = new BadRequestException("nope");
    h.settle.mockRejectedValue(boom);
    await expect(edit(h)).rejects.toBe(boom);
    expect(h.settle).toHaveBeenCalledTimes(1);
  });
});

describe("reopen: the re-decrement tx inside retryStockTx", () => {
  it("a 55P03 on the header write re-runs the tx; the reopen commits once", async () => {
    const h = await buildOversellOrders("off");
    h.prisma.order.findUnique.mockResolvedValue({
      id: "ord-1",
      customerId: "cust-1",
      tenantId: TENANT,
      status: "CANCELLED",
      notes: null,
      lineItems: [],
    });
    h.prisma.invoice.findFirst.mockResolvedValue(null);
    h.prisma.orderItem.findMany.mockResolvedValue([]);
    h.prisma.order.update
      .mockRejectedValueOnce(lockTimeout())
      .mockResolvedValue({ id: "ord-1", status: "PENDING" });
    const committed = emulateRollback(h, [h.prisma.orderItem.updateMany as jest.Mock]);

    await expect(h.service.reopenOrder("ord-1")).resolves.toMatchObject({ status: "PENDING" });
    expect(h.prisma.tenantTransaction).toHaveBeenCalledTimes(2);
    expect(committed(h.prisma.orderItem.updateMany as jest.Mock)).toBe(1);
  });
});

/** Every stock-writing order tx is wrapped; the bare conflict retry is gone from the stock paths. */
describe("placement: the order sale sites use retryStockTx", () => {
  const read = (rel: string) =>
    fs.readFileSync(path.join(__dirname, "..", rel), "utf8").replace(/\/\/[^\n]*/g, "");
  const orders = read("orders/orders.service.ts");

  it.each([
    "orders.create",
    "orders.promoteDraft",
    "orders.demoteToDraft",
    "orders.cancel",
    "orders.reopen",
    "orders.approveChangeRequestAtStop",
  ])("orders.service runs %s through stockTx", (label) => {
    const at = orders.indexOf(`"${label}"`);
    expect(at).toBeGreaterThan(-1);
    expect(orders.slice(Math.max(0, at - 40), at)).toMatch(/this\.stockTx\(\s*$/);
  });

  it("stockTx is retryStockTx around the unchanged tenantTransaction(fn, opts)", () => {
    expect(orders).toContain("retryStockTx(label, () => this.prisma.tenantTransaction(fn, opts))");
  });

  it("the edit tx helper wraps every edit (plain or with an inline return) in retryStockTx", () => {
    expect(read("orders/order-inline-return.ts")).toContain(
      'retryStockTx("orders.updateOrderItems"',
    );
  });

  it("order-templates generation wraps its stock tx", () => {
    expect(read("order-templates/order-templates.service.ts")).toContain(
      'retryStockTx("orderTemplates.generate"',
    );
  });

  it("the bare retryOnTxConflict is gone from the orders service stock paths", () => {
    expect(orders).not.toMatch(/\bretryOnTxConflict\b/);
  });
});
