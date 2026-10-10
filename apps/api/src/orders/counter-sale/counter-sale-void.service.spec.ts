// The harness FIRST: it jest.mock()s modules that orders.service also imports.
import { buildOrdersService } from "../testing/orders-service-harness";
import { InvoicesService } from "../../invoices/invoices.service";
import { decrementStockForSale } from "../order-stock";
import { LockTimeoutError, LockUnavailableError, withAdvisoryLock } from "../../common/db-locks";
import { RouteFlowGateway } from "../../gateways/routeflow.gateway";
import { CounterSaleVoidService } from "./counter-sale-void.service";

// The advisory lock needs a pg pool; these specs exercise the void's logic, so run the critical section inline.
// A test that needs the lock to fail overrides it for one call.
jest.mock("../../common/db-locks", () => ({
  ...jest.requireActual("../../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const operator = {
  sub: "user-op",
  username: "operator",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};
const pay = (over: Record<string, unknown>) => ({
  id: "pay-1",
  invoiceId: "inv-1",
  method: "CASH",
  status: "PAID",
  amount: 30,
  paymentGroupId: null,
  checkStatus: null,
  ...over,
});
const CASH = pay({});
const CARD = pay({ id: "pay-2", invoiceId: "inv-2", method: "CREDIT_CARD", amount: 20 });

async function build(
  opts: {
    order?: Record<string, unknown> | null;
    invoiceStatuses?: string[];
    payments?: unknown[];
    lines?: unknown[];
    products?: Array<{ id: string; unitsPerBox: number | null }>;
    mutations?: unknown[];
    pack?: number | null;
    returnProbe?: unknown;
    refundProbe?: unknown;
    prior?: unknown;
    tz?: string | null;
  } = {},
) {
  const h = await buildOrdersService();
  const { prisma } = h;
  const order =
    opts.order === null
      ? null
      : {
          id: ORDER_ID,
          orderNumber: "ORD-9",
          customerId: "cust-1",
          status: "DELIVERED",
          counterSale: true,
          createdAt: new Date(), // today in any tenant zone
          ...opts.order,
        };
  prisma.order.findFirst.mockResolvedValue(order);
  prisma.order.findUnique.mockImplementation(async (args: any) =>
    args?.select?.status ? { status: order?.status } : { ...order },
  );
  prisma.order.updateMany.mockResolvedValue({ count: 1 });
  const statuses = opts.invoiceStatuses ?? ["SENT", "SENT"];
  prisma.invoice.findMany.mockImplementation(async (args: any) => {
    if (args?.select?.status) return statuses.map((status) => ({ status })); // the void's dead-or-live read
    if (args?.where?.id) return [{ invoiceNumber: "INV-1", payments: [] }]; // lockOrderForCancel's re-read
    return [{ id: "inv-1" }, { id: "inv-2" }]; // cancelOrderInTx's live invoices
  });
  prisma.invoicePayment.findMany.mockResolvedValue(opts.payments ?? [CASH, CARD]);
  prisma.return.findFirst.mockImplementation(async (args: any) =>
    JSON.stringify(args?.where ?? {}).includes("EXTERNAL_REFUND")
      ? (opts.refundProbe ?? null)
      : (opts.returnProbe ?? null),
  );
  prisma.invoiceItem.findMany.mockResolvedValue([]);
  prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: opts.tz ?? "America/Chicago" });
  prisma.auditLog.findFirst.mockResolvedValue(opts.prior ?? null);
  prisma.auditLog.create.mockResolvedValue({});
  // The order's lines as a tiny in-memory table: the void's hand-over reset and the cancel's settle/marking read
  // and write it, so what the reset does reaches the stock credit (a mock that ignores writes could not show it).
  const lines: any[] = (
    opts.lines ?? [
      {
        productId: "prod-1",
        qty: 5,
        deliveredQty: 0,
        status: "DELIVERED",
        unitsPerBox: null,
        boxes: null,
        pieces: null,
        unitLabel: null,
      },
    ]
  ).map((l: any, i) => ({ id: `line-${i + 1}`, ...l }));
  prisma.orderItem.findMany.mockImplementation(async (args: any) =>
    lines.filter(
      (l) =>
        (args?.where?.deliveredQty?.gt === undefined ||
          Number(l.deliveredQty) > args.where.deliveredQty.gt) &&
        (args?.where?.status?.not === undefined || l.status !== args.where.status.not),
    ),
  );
  prisma.orderItem.updateMany.mockImplementation(async (args: any) => {
    const hit = lines.filter((l) => !args?.where?.id?.in || args.where.id.in.includes(l.id));
    for (const l of hit) Object.assign(l, args.data);
    return { count: hit.length };
  });
  prisma.deliveryMutation.findMany.mockResolvedValue((opts.mutations ?? []) as never);
  const catalog = opts.products ?? [{ id: "prod-1", unitsPerBox: opts.pack ?? null }];
  prisma.product.findMany.mockImplementation(async (args: any) =>
    catalog
      .filter((p) => !args?.where?.id?.in || args.where.id.in.includes(p.id))
      .map((p) => ({ ...p, name: `P ${p.id}`, currentStock: 50 })),
  );
  prisma.product.update.mockResolvedValue({ id: "prod-1", currentStock: 55 } as never);
  const tx = {
    ...prisma,
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([{ id: "inv-1" }, { id: "inv-2" }]),
  };
  prisma.tenantTransaction.mockImplementation((fn: any) => fn(tx));
  const invoices = h.module.get(InvoicesService) as unknown as Record<string, jest.Mock>;
  invoices.voidPaymentInTx = jest.fn().mockResolvedValue({ success: true });
  const gateway = h.module.get(RouteFlowGateway) as unknown as {
    emitOrderStatusChanged: jest.Mock;
  };
  const svc = new CounterSaleVoidService(h.service, invoices as never, prisma, gateway as never);
  return { ...h, tx, invoices, gateway, svc, order, lines };
}
type Built = Awaited<ReturnType<typeof build>>;

beforeEach(() => (withAdvisoryLock as jest.Mock).mockClear());

const run = (b: Built, user: object = operator, reason = "rang the wrong item") =>
  b.svc.voidSale(ORDER_ID, { reason }, user as never);
const code = async (p: Promise<unknown>) => {
  const e: any = await p.catch((x) => x);
  return { status: e?.getStatus?.(), body: e?.getResponse?.() };
};
/** Nothing was written: no payment void, no cancel claim, no stock move, no audit row, no emit. */
const expectNoWrites = (b: Built) => {
  expect(b.invoices.voidPaymentInTx).not.toHaveBeenCalled();
  expect(b.prisma.order.updateMany).not.toHaveBeenCalled();
  expect(b.prisma.product.update).not.toHaveBeenCalled();
  expect(b.prisma.auditLog.create).not.toHaveBeenCalled();
  expect(b.gateway.emitOrderStatusChanged).not.toHaveBeenCalled();
};

describe("CounterSaleVoidService: a same-day cash + card sale (test 4)", () => {
  it("voids the tender, cancels the sale, restocks, audits once and hands back the PAID amounts", async () => {
    const b = await build();
    await expect(run(b)).resolves.toEqual({ voided: true, handBack: { CASH: 30, CARD: 20 } });

    // both payments voided with the one payment-void writer, in invoice order
    expect(b.invoices.voidPaymentInTx).toHaveBeenCalledTimes(2);
    expect(b.invoices.voidPaymentInTx).toHaveBeenNthCalledWith(
      1,
      b.tx,
      expect.anything(),
      "inv-1",
      "pay-1",
      "America/Chicago",
    );
    expect(b.invoices.voidPaymentInTx).toHaveBeenNthCalledWith(
      2,
      b.tx,
      expect.anything(),
      "inv-2",
      "pay-2",
      "America/Chicago",
    );
    // the order cancel unwind from DELIVERED: CAS claim, stock back, both invoices voided
    const claim = b.prisma.order.updateMany.mock.calls[0][0];
    expect(claim).toEqual({
      where: { id: ORDER_ID, status: { in: ["DELIVERED"] } },
      data: { status: "CANCELLED" },
    });
    expect(b.prisma.product.update).toHaveBeenCalledWith({
      where: { id: "prod-1" },
      data: { currentStock: { increment: 5 } },
    });
    const voided = b.module.get(InvoicesService) as unknown as Record<string, jest.Mock>;
    expect(voided.voidInvoiceInTx).toHaveBeenCalledWith(b.tx, "inv-1", ORDER_ID);
    expect(voided.voidInvoiceInTx).toHaveBeenCalledWith(b.tx, "inv-2", ORDER_ID);
    // ONE audit row with the reason, the hand-back and the actor, written in the tx
    expect(b.prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(b.prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: "counter-sale.voided",
      entityType: "Order",
      entityId: ORDER_ID,
      userId: "user-op",
      meta: {
        orderId: ORDER_ID,
        reason: "rang the wrong item",
        handBack: { CASH: 30, CARD: 20 },
        actor: "user-op",
      },
    });
    // order of operations: tender voids -> cancel claim -> stock credit -> audit; the emit only after the tx
    const at = (m: { mock: { invocationCallOrder: number[] } }) => m.mock.invocationCallOrder[0];
    expect(at(b.invoices.voidPaymentInTx as never)).toBeLessThan(at(b.prisma.order.updateMany));
    expect(at(b.prisma.order.updateMany)).toBeLessThan(at(b.prisma.product.update));
    expect(at(b.prisma.product.update)).toBeLessThan(at(b.prisma.auditLog.create));
    expect(b.gateway.emitOrderStatusChanged).toHaveBeenCalledTimes(1);
    expect(b.gateway.emitOrderStatusChanged).toHaveBeenCalledWith(
      "test-tenant",
      expect.objectContaining({
        orderId: ORDER_ID,
        status: "CANCELLED",
        previousStatus: "DELIVERED",
      }),
    );
    expect(b.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      at(b.invoices.voidPaymentInTx as never),
    );
    // runs inside the SERIALIZABLE tx, under the counter-tender lock keyed on the order, waiting up to 10 s
    expect(b.prisma.tenantTransaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
      timeout: 15_000,
    });
    expect(withAdvisoryLock).toHaveBeenCalledWith(
      { family: "counter-tender", key: ORDER_ID, mode: "wait", waitMs: 10_000 },
      expect.any(Function),
    );
  });

  it.each([
    [
      "a box-split line (2 boxes + 3 loose pieces of a 12-pack)",
      { qty: 27, boxes: 2, pieces: 3, unitsPerBox: 12 },
      27,
    ],
    [
      "a box-unaware line (2 boxes of a 12-pack, sized by the live pack)",
      { qty: 2, boxes: null, pieces: null, unitsPerBox: null },
      24,
    ],
  ])("%s: the restock equals create()'s piece decrement", async (_name, units, pieces) => {
    const line = {
      productId: "prod-1",
      deliveredQty: 0,
      status: "DELIVERED",
      unitLabel: null,
      ...units,
    };
    // create()'s decrement for this exact line, from the real helper: the piece quantity it writes
    const sql: Array<{ values: unknown[] }> = [];
    const sale = {
      $executeRaw: jest.fn(),
      product: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: "prod-1", name: "P", currentStock: 100, unitsPerBox: 12 }]),
      },
      $queryRaw: jest.fn(async (_s: TemplateStringsArray, ...values: unknown[]) => {
        sql.push(
          ...(values.filter(
            (v) => typeof v === "object" && v !== null && "values" in v,
          ) as never[]),
        );
        return [];
      }),
    };
    await decrementStockForSale(
      { logger: { warn: jest.fn() } as never, tenantId: "t" },
      sale,
      [line as never],
      true,
      { orderId: "o", notes: "SALE" } as never,
    );
    const decremented = Number(sql[0].values[1]);
    expect(decremented).toBe(pieces);

    const b = await build({ lines: [line], pack: 12 });
    await run(b);
    expect(b.prisma.product.update).toHaveBeenCalledWith({
      where: { id: "prod-1" },
      data: { currentStock: { increment: decremented } },
    });
  });

  it("the invoice.updated events voidPaymentInTx queues (SENT/OVERDUE) are dropped: the invoices end VOID, only the order event goes out", async () => {
    const b = await build();
    const invoiceGateway = { emitInvoiceUpdated: jest.fn() };
    // like the real voidPaymentInTx: it queues an invoice.updated on the AfterCommit it is handed
    b.invoices.voidPaymentInTx.mockImplementation(
      async (_tx: unknown, after: any, invoiceId: string) => {
        after
          .defer(invoiceGateway)
          .emitInvoiceUpdated("test-tenant", { invoiceId, status: "SENT" });
        return { success: true };
      },
    );
    await run(b);
    expect(b.invoices.voidPaymentInTx).toHaveBeenCalledTimes(2);
    expect(invoiceGateway.emitInvoiceUpdated).not.toHaveBeenCalled();
    expect(b.gateway.emitOrderStatusChanged).toHaveBeenCalledTimes(1);
  });

  it("a PENDING check leg is voided but hands nothing back; a split leg per invoice is each voided", async () => {
    const pending = pay({
      id: "pay-3",
      method: "CHECK",
      status: "PENDING",
      checkStatus: "RECORDED",
      amount: 15,
    });
    const b = await build({ payments: [CASH, pending] });
    await expect(run(b)).resolves.toEqual({ voided: true, handBack: { CASH: 30 } });
    expect(b.invoices.voidPaymentInTx).toHaveBeenCalledTimes(2);
  });

  it("an on-account sale (no tender) voids with an empty hand-back", async () => {
    const b = await build({ payments: [] });
    await expect(run(b)).resolves.toEqual({ voided: true, handBack: {} });
    expect(b.invoices.voidPaymentInTx).not.toHaveBeenCalled();
    expect(b.prisma.order.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("CounterSaleVoidService: the void undoes the hand-over (a DELIVERED write that stamps deliveredQty)", () => {
  const line = (over: Record<string, unknown>) => ({
    productId: "prod-1",
    qty: 5,
    deliveredQty: 5,
    status: "DELIVERED",
    unitsPerBox: null,
    boxes: null,
    pieces: null,
    unitLabel: null,
    ...over,
  });
  const incrementOf = (b: Built, productId: string) =>
    b.prisma.product.update.mock.calls.find((c: any[]) => c[0].where.id === productId)?.[0].data
      .currentStock.increment;

  it("lines left with deliveredQty = qty (POS mode) are fully restocked, a boxed line included", async () => {
    const b = await build({
      lines: [
        line({ id: "l1" }),
        line({
          id: "l2",
          productId: "prod-2",
          qty: 27,
          deliveredQty: 27,
          boxes: 2,
          pieces: 3,
          unitsPerBox: 12,
        }),
      ],
      products: [
        { id: "prod-1", unitsPerBox: null },
        { id: "prod-2", unitsPerBox: 12 },
      ],
    });
    await run(b);
    expect(incrementOf(b, "prod-1")).toBe(5);
    expect(incrementOf(b, "prod-2")).toBe(27); // 2 boxes + 3 pieces of a 12-pack, all of it
    // the reset is one write on exactly those lines, under the order lock, before the cancel's claim
    expect(b.prisma.orderItem.updateMany.mock.calls[0][0]).toEqual({
      where: { id: { in: ["l1", "l2"] }, orderId: ORDER_ID },
      data: { deliveredQty: 0 },
    });
    expect(b.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      b.prisma.orderItem.updateMany.mock.invocationCallOrder[0],
    );
    expect(b.prisma.orderItem.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      b.prisma.order.updateMany.mock.invocationCallOrder[0],
    );
  });

  it("a line WITH a qualifying DeliveryMutation row keeps its deliveredQty (evidence is never rewritten) and is not restocked", async () => {
    const b = await build({
      lines: [line({ id: "l1" }), line({ id: "l2", productId: "prod-2", qty: 4, deliveredQty: 4 })],
      products: [
        { id: "prod-1", unitsPerBox: null },
        { id: "prod-2", unitsPerBox: null },
      ],
      mutations: [{ orderItemId: "l2", type: "DELIVERED", quantityDelivered: 4 }],
    });
    await run(b);
    expect(b.prisma.orderItem.updateMany.mock.calls[0][0].where.id).toEqual({ in: ["l1"] });
    expect(b.lines.find((l) => l.id === "l2").deliveredQty).toBe(4);
    expect(incrementOf(b, "prod-1")).toBe(5);
    expect(incrementOf(b, "prod-2")).toBeUndefined(); // its delivered units stay booked
  });

  it("an order whose lines carry no delivered quantity writes no reset at all (today's counter sale)", async () => {
    const b = await build({ lines: [line({ id: "l1", deliveredQty: 0 })] });
    await run(b);
    const resets = b.prisma.orderItem.updateMany.mock.calls.filter(
      (c: any[]) => "deliveredQty" in (c[0].data ?? {}),
    );
    expect(resets).toHaveLength(0);
    expect(incrementOf(b, "prod-1")).toBe(5);
  });
});

describe("CounterSaleVoidService: replay and refusals (test 5), each with no write", () => {
  it("a sale this endpoint already voided answers 200 replayed with the stored hand-back and writes nothing", async () => {
    const prior = {
      meta: { orderId: ORDER_ID, reason: "x", handBack: { CASH: 30, CARD: 20 }, actor: "u" },
    };
    const b = await build({
      order: { status: "CANCELLED" },
      invoiceStatuses: ["VOID", "VOID"],
      prior,
    });
    await expect(run(b)).resolves.toEqual({
      voided: true,
      replayed: true,
      handBack: { CASH: 30, CARD: 20 },
    });
    expectNoWrites(b);
  });

  it("a sale cancelled in the office (no void audit row) is 409 COUNTER_SALE_VOIDED", async () => {
    const b = await build({ order: { status: "CANCELLED" }, invoiceStatuses: ["VOID", "VOID"] });
    expect(await code(run(b))).toEqual({
      status: 409,
      body: expect.objectContaining({ code: "COUNTER_SALE_VOIDED" }),
    });
    expectNoWrites(b);
  });

  it("every invoice VOID on a live order is dead too: 409 COUNTER_SALE_VOIDED", async () => {
    const b = await build({
      invoiceStatuses: ["VOID", "WRITTEN_OFF"],
      prior: { meta: { handBack: {} } },
    });
    expect(await code(run(b))).toMatchObject({
      status: 409,
      body: { code: "COUNTER_SALE_VOIDED" },
    });
    expectNoWrites(b);
  });

  it("a recorded cash refund is 409 ORDER_HAS_CASH_REFUND", async () => {
    const b = await build({ refundProbe: { id: "ret-1" } });
    expect(await code(run(b))).toMatchObject({
      status: 409,
      body: { code: "ORDER_HAS_CASH_REFUND" },
    });
    expectNoWrites(b);
  });

  it("any return on the sale is 409 COUNTER_SALE_VOID_HAS_RETURN (as the carrying order or as the source order)", async () => {
    const b = await build({ returnProbe: { id: "ret-2" } });
    expect(await code(run(b))).toMatchObject({
      status: 409,
      body: { code: "COUNTER_SALE_VOID_HAS_RETURN" },
    });
    expect(
      b.prisma.return.findFirst.mock.calls
        .map((c: any[]) => c[0].where)
        .some(
          (w: any) =>
            JSON.stringify(w) ===
            JSON.stringify({
              OR: [{ orderId: ORDER_ID }, { items: { some: { sourceOrderId: ORDER_ID } } }],
            }),
        ),
    ).toBe(true);
    expectNoWrites(b);
  });

  it.each([
    [
      "an office payment with a random group id",
      pay({ paymentGroupId: "5b0f4a6e-2b0a-4c53-9a54-6f1c8d1f2a11" }),
    ],
    ["an auto-applied credit note", pay({ id: "pay-9", method: "CREDIT_NOTE", amount: 10 })],
    ["an advance application", pay({ id: "pay-9", method: "ADVANCE", amount: 10 })],
    [
      "a DEPOSITED check",
      pay({ id: "pay-9", method: "CHECK", checkStatus: "DEPOSITED", amount: 10 }),
    ],
    ["a CLEARED check", pay({ id: "pay-9", method: "CHECK", checkStatus: "CLEARED", amount: 10 })],
  ])("%s is FOREIGN: 409 COUNTER_SALE_VOID_FOREIGN_PAYMENT", async (_name, foreign) => {
    const b = await build({ payments: [CASH, foreign] });
    expect(await code(run(b))).toMatchObject({
      status: 409,
      body: { code: "COUNTER_SALE_VOID_FOREIGN_PAYMENT" },
    });
    expectNoWrites(b);
  });

  it("a sale rung on an earlier day in the tenant zone is 409 COUNTER_SALE_VOID_NOT_TODAY", async () => {
    const b = await build({ order: { createdAt: new Date(Date.now() - 48 * 3600_000) } });
    expect(await code(run(b))).toMatchObject({
      status: 409,
      body: { code: "COUNTER_SALE_VOID_NOT_TODAY" },
    });
    expectNoWrites(b);
  });

  it("a sale that is not a counter sale, or is not this tenant's, is 404 before any lock is taken", async () => {
    const other = await build({ order: null });
    expect(await code(run(other))).toMatchObject({
      status: 404,
      body: { code: "COUNTER_SALE_NOT_FOUND" },
    });
    expect(withAdvisoryLock).not.toHaveBeenCalledWith(expect.anything(), expect.anything());
    expectNoWrites(other);
    // visible to the pre-check but not a counter sale under the lock (flipped): still 404, nothing written
    const flipped = await build({ order: { counterSale: false } });
    flipped.prisma.order.findFirst.mockResolvedValueOnce({ id: ORDER_ID });
    expect(await code(run(flipped))).toMatchObject({
      status: 404,
      body: { code: "COUNTER_SALE_NOT_FOUND" },
    });
    expectNoWrites(flipped);
  });

  it("the role gate: a DRIVER (no VOID_SALE) is 403 and a tenant-less session is 403; nothing is read or written", async () => {
    const b = await build();
    expect((await code(run(b, { ...operator, role: "DRIVER" }))).status).toBe(403);
    b.prisma.getTenantId.mockReturnValueOnce(null);
    expect((await code(run(b))).status).toBe(403);
    expectNoWrites(b);
  });

  it("a lock timeout or an unavailable lock connection is 503 COUNTER_SALE_VOID_BUSY with nothing written", async () => {
    for (const err of [
      new LockTimeoutError("counter-tender", ORDER_ID, 10_000),
      new LockUnavailableError(new Error("down")),
    ]) {
      const b = await build();
      (withAdvisoryLock as jest.Mock).mockRejectedValueOnce(err);
      expect(await code(run(b))).toMatchObject({
        status: 503,
        body: { code: "COUNTER_SALE_VOID_BUSY" },
      });
      expectNoWrites(b);
    }
  });

  it("serialization conflicts that outlast the retries are 503 COUNTER_SALE_VOID_BUSY too", async () => {
    const b = await build();
    b.prisma.tenantTransaction.mockRejectedValue(
      Object.assign(new Error("conflict"), { code: "P2034" }),
    );
    expect(await code(run(b))).toMatchObject({
      status: 503,
      body: { code: "COUNTER_SALE_VOID_BUSY" },
    });
    expect(b.prisma.tenantTransaction).toHaveBeenCalledTimes(3);
    expectNoWrites(b);
  }, 10_000);
});
