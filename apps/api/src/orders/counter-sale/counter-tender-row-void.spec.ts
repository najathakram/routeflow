// The harness FIRST: it jest.mock()s modules that orders.service also imports.
import { buildOrdersService } from "../testing/orders-service-harness";
import { InvoicesService } from "../../invoices/invoices.service";
import { RouteFlowGateway } from "../../gateways/routeflow.gateway";
import { CounterSaleVoidService } from "./counter-sale-void.service";
import { legGroupId, legGroupIds } from "./counter-tender-row";
import { pickupTenderGroupId } from "./pickup-tender-group";

jest.mock("../../common/db-locks", () => ({
  ...jest.requireActual("../../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

/**
 * SA ruling (mirror b7bfeccd0): a counter sale is a PICKUP order too, so pickup-complete stamps
 * `paymentGroupId = pickupTenderGroupId(orderId)` on its cash. The ONE tender-row predicate accepts that id on a counter order,
 * so the counter void treats the hand-over cash as its own tender (voids it and hands it back) instead of refusing it as foreign.
 * The harness is copied from counter-sale-void.service.spec.ts (not edited there).
 */
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORDER_ID = "22222222-2222-4222-8222-222222222222";
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

async function build(payments: unknown[]) {
  const h = await buildOrdersService();
  const { prisma } = h;
  const order = {
    id: ORDER_ID,
    orderNumber: "ORD-9",
    customerId: "cust-1",
    status: "DELIVERED",
    counterSale: true,
    createdAt: new Date(), // today in any tenant zone
  };
  prisma.order.findFirst.mockResolvedValue(order);
  prisma.order.findUnique.mockImplementation(async (args: any) =>
    args?.select?.status ? { status: order.status } : { ...order },
  );
  prisma.order.updateMany.mockResolvedValue({ count: 1 });
  prisma.invoice.findMany.mockImplementation(async (args: any) => {
    if (args?.select?.status) return [{ status: "SENT" }]; // the void's dead-or-live read
    if (args?.where?.id) return [{ invoiceNumber: "INV-1", payments: [] }]; // lockOrderForCancel's re-read
    return [{ id: "inv-1" }]; // cancelOrderInTx's live invoices
  });
  prisma.invoicePayment.findMany.mockResolvedValue(payments);
  prisma.return.findFirst.mockResolvedValue(null);
  prisma.invoiceItem.findMany.mockResolvedValue([]);
  prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: "America/Chicago" });
  prisma.auditLog.findFirst.mockResolvedValue(null);
  prisma.auditLog.create.mockResolvedValue({});
  const lines: any[] = [
    {
      id: "line-1",
      productId: "prod-1",
      qty: 5,
      deliveredQty: 0,
      status: "DELIVERED",
      unitsPerBox: null,
      boxes: null,
      pieces: null,
      unitLabel: null,
    },
  ];
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
  prisma.deliveryMutation.findMany.mockResolvedValue([] as never);
  prisma.product.findMany.mockImplementation(async (args: any) =>
    [{ id: "prod-1", unitsPerBox: null, name: "P prod-1", currentStock: 50 }].filter(
      (p) => !args?.where?.id?.in || args.where.id.in.includes(p.id),
    ),
  );
  prisma.product.update.mockResolvedValue({ id: "prod-1", currentStock: 55 } as never);
  const tx = {
    ...prisma,
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
  };
  prisma.tenantTransaction.mockImplementation((fn: any) => fn(tx));
  const invoices = h.module.get(InvoicesService) as unknown as Record<string, jest.Mock>;
  invoices.voidPaymentInTx = jest.fn().mockResolvedValue({ success: true });
  const gateway = h.module.get(RouteFlowGateway) as unknown as {
    emitOrderStatusChanged: jest.Mock;
  };
  const svc = new CounterSaleVoidService(h.service, invoices as never, prisma, gateway as never);
  return { ...h, tx, invoices, gateway, svc };
}

const run = (b: Awaited<ReturnType<typeof build>>) =>
  b.svc.voidSale(ORDER_ID, { reason: "rang the wrong item" }, operator as never);

describe("counter void: a counter order's pickup hand-over cash is its own tender", () => {
  it("voids the row carrying pickupTenderGroupId(orderId) and hands it back (no COUNTER_SALE_VOID_FOREIGN_PAYMENT)", async () => {
    const handOver = pay({ paymentGroupId: pickupTenderGroupId(ORDER_ID) });
    const b = await build([handOver]);
    await expect(run(b)).resolves.toEqual({ voided: true, handBack: { CASH: 30 } });
    expect(b.invoices.voidPaymentInTx).toHaveBeenCalledTimes(1);
    expect(b.invoices.voidPaymentInTx).toHaveBeenCalledWith(
      b.tx,
      expect.anything(),
      "inv-1",
      "pay-1",
      "America/Chicago",
    );
  });

  it("an ungrouped tender beside the hand-over cash is voided too (both handed back)", async () => {
    const b = await build([
      pay({ id: "pay-1", amount: 12 }),
      pay({ id: "pay-2", amount: 18, paymentGroupId: pickupTenderGroupId(ORDER_ID) }),
    ]);
    await expect(run(b)).resolves.toEqual({ voided: true, handBack: { CASH: 30 } });
    expect(b.invoices.voidPaymentInTx).toHaveBeenCalledTimes(2);
  });

  it("another order's pickup id on this sale's payment is still FOREIGN: 409, nothing written", async () => {
    const b = await build([pay({ paymentGroupId: pickupTenderGroupId(OTHER_ORDER_ID) })]);
    const e: any = await run(b).catch((x) => x);
    expect(e?.getStatus?.()).toBe(409);
    expect(e?.getResponse?.()).toMatchObject({ code: "COUNTER_SALE_VOID_FOREIGN_PAYMENT" });
    expect(b.invoices.voidPaymentInTx).not.toHaveBeenCalled();
    expect(b.prisma.order.updateMany).not.toHaveBeenCalled();
    expect(b.prisma.auditLog.create).not.toHaveBeenCalled();
  });

  // A2: the void judges rows against the SAME set the day close and the closed-day guard read: every payment row of the
  // ORDER (a voided sibling invoice's, and VOID rows too) decides "has a leg-grouped row", not the live invoices' alone.
  it("an ungrouped cash row beside a leg row that sits on a VOIDED sibling invoice is FOREIGN: 409, nothing written", async () => {
    const office = pay({ id: "office", amount: 12 });
    const b = await build([office]);
    const evidence = [{ paymentGroupId: legGroupId(ORDER_ID, 0), status: "VOID" }];
    b.prisma.invoicePayment.findMany.mockImplementation(async (args: any) =>
      args?.where?.paymentGroupId ? evidence : [office],
    );
    const e: any = await run(b).catch((x) => x);
    expect(e?.getStatus?.()).toBe(409);
    expect(e?.getResponse?.()).toMatchObject({ code: "COUNTER_SALE_VOID_FOREIGN_PAYMENT" });
    expect(b.invoices.voidPaymentInTx).not.toHaveBeenCalled();
    // the evidence is asked for by the order's own leg ids over EVERY invoice of the order (no status filter)
    const ask = b.prisma.invoicePayment.findMany.mock.calls
      .map((c: any[]) => c[0])
      .find((a: any) => a?.where?.paymentGroupId);
    expect(ask.where.paymentGroupId.in).toEqual(legGroupIds(ORDER_ID));
    expect(ask.where.invoice).toEqual({ orderId: ORDER_ID });
    expect(ask.where.status).toBeUndefined();
  });

  it("the same ungrouped row on a sale with NO leg row anywhere is still its legacy tender (voided and handed back)", async () => {
    const office = pay({ id: "office", amount: 12 });
    const b = await build([office]);
    b.prisma.invoicePayment.findMany.mockImplementation(async (args: any) =>
      args?.where?.paymentGroupId ? [] : [office],
    );
    await expect(run(b)).resolves.toEqual({ voided: true, handBack: { CASH: 12 } });
  });
});
