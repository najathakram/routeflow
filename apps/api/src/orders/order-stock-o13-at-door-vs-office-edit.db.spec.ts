/**
 * O13 (inventory TEST-PLAN W1b, B709): an at-door approve and an office edit interleaved on ONE order.
 *
 * Stock 10 (OPENING 10), an order holding 2 of the product (stock 8) on an IN_PROGRESS run, a pending CHANGE_QTY
 * change request to 5. An office replace-all edit sets the line to 3 at the same moment the driver's
 * `approveChangeRequestAtStop` merges the 5. Both read the order BEFORE their transaction (the stale snapshot B709
 * is about) and a barrier on the first transaction each opens releases them together, so each priced / gated off a
 * pre-lock read and the Order row lock then serialises the writes. Correct: ONE serial outcome. Whichever wrote
 * last wins the line (qty 3 or 5), the stock counter is `10 - that qty`, the order subtotal is `5 x that qty`, no
 * caller fails with anything but a coded 409, and the ledger is consistent (X1). The pre-fix wrong value is a
 * wrong-MAGNITUDE credit (the van carries 5, the order says 2, stock +3 phantom).
 *
 * Status on master: see the report. #1243 (B709) re-reads the held rows under the lock; the open remainder of
 * B709 (invoice-create's `invoicedQty` increment racing a line DELETE) needs the real InvoicesService and is NOT
 * covered here. Linked bug: B709 (registry: PARTIAL, #1243 merged).
 *
 * Real OrdersService over the shared world fixture + real Postgres; test tenant `qa-o13-*` only.
 */
import { describeDb } from "../common/testing/db-spec";
import { buildOrderStockWorld, type OrderStockWorld } from "../inventory/testing/order-stock-world";
import { expectLedgerConsistent } from "../inventory/testing/ledger-consistency";

describeDb("O13 / B709: at-door approve vs office edit on one order", () => {
  let w: OrderStockWorld;
  let arrivals = 0;
  let release!: () => void;
  const bothIn = new Promise<void>((r) => (release = r));

  beforeAll(async () => {
    w = await buildOrderStockWorld("o13", "order-stock-o13-at-door-vs-office-edit.db.spec.ts");
    const real = w.orders.prisma;
    w.orders.prisma = new Proxy(real, {
      get(target: any, prop) {
        if (prop === "tenantTransaction") {
          return async (fn: unknown, opts?: unknown) => {
            if (arrivals < 2) {
              arrivals += 1;
              if (arrivals >= 2) release();
              await Promise.race([bothIn, new Promise((r) => setTimeout(r, 1500))]);
            }
            return target.tenantTransaction(fn, opts);
          };
        }
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }, 120_000);
  afterAll(async () => {
    const swallow = () => undefined;
    if (w) {
      const where = { where: { tenantId: w.tenantId } };
      await w.prisma.changeRequest.deleteMany(where).catch(swallow);
      await w.prisma.order
        .updateMany({ ...where, data: { routeRunId: null, routeRunStopId: null } })
        .catch(swallow);
      await w.prisma.routeRunStop.deleteMany(where).catch(swallow);
      await w.prisma.routeRun.deleteMany(where).catch(swallow);
      await w.prisma.routeStop.deleteMany(where).catch(swallow);
      await w.prisma.route.deleteMany(where).catch(swallow);
    }
    await w?.cleanup();
  }, 120_000);

  it("B709: office replace-all to 3 || at-door approve of 5 -> one serial outcome, stock and order agree", async () => {
    const productId = await w.product("o13", 10);
    const { order, items } = await w.bookOrder({
      status: "CONFIRMED",
      lines: [{ productId, qty: 2 }],
    });
    const customerId = order.customerId;
    const route = await w.prisma.route.create({
      data: { name: `o13 route ${w.slug}`, tenantId: w.tenantId } as any,
    });
    const routeStop = await w.prisma.routeStop.create({
      data: { tenantId: w.tenantId, routeId: route.id, stopNumber: 1, customerId } as any,
    });
    const driver = await w.prisma.user.create({
      data: {
        email: `${w.slug}-drv@example.invalid`,
        username: `${w.slug}-drv`,
        role: "DRIVER",
        tenantId: w.tenantId,
      },
    });
    const driverRow = await w.prisma.driver.create({
      data: { userId: driver.id, tenantId: w.tenantId } as any,
    });
    const run = await w.prisma.routeRun.create({
      data: {
        tenantId: w.tenantId,
        routeId: route.id,
        scheduledDate: new Date("2026-09-27T00:00:00.000Z"),
        status: "IN_PROGRESS",
        driverId: driverRow.id,
      } as any,
    });
    const stop = await w.prisma.routeRunStop.create({
      data: {
        tenantId: w.tenantId,
        routeRunId: run.id,
        routeStopId: routeStop.id,
        stopNumber: 1,
        status: "IN_PROGRESS",
      } as any,
    });
    await w.prisma.order.update({
      where: { id: order.id },
      data: { routeRunId: run.id, routeRunStopId: stop.id },
    });
    const cr = await w.prisma.changeRequest.create({
      data: {
        tenantId: w.tenantId,
        orderId: order.id,
        orderItemId: items[0].id,
        productId,
        routeRunStopId: stop.id,
        type: "CHANGE_QTY" as any,
        payload: { orderItemId: items[0].id, newQty: 5 },
      },
    });
    expect(await w.stockOf(productId)).toBe(8); // fixture sanity

    const office = w.inTenant(() =>
      w.orders.updateOrderItems(
        order.id,
        { replaceAll: true, items: [{ productId, qty: 3, unitPrice: "5.00" }] },
        w.jwt,
      ),
    );
    const atDoor = w.inTenant(() =>
      w.orders.approveChangeRequestAtStop(cr.id, { ...w.jwt, role: "OPERATOR" }, "at the door"),
    );
    const results = await Promise.allSettled([office, atDoor]);

    expect(arrivals).toBe(2); // entry: both callers were past their pre-lock reads and inside a transaction together
    const codes = results.map((r) =>
      r.status === "fulfilled"
        ? "ok"
        : `${(r.reason as any)?.getStatus?.() ?? (r.reason as any)?.constructor?.name}:${String((r.reason as any)?.message ?? r.reason).slice(0, 80)}`,
    );
    const lines = await w.prisma.orderItem.findMany({
      where: { orderId: order.id, status: { not: "CANCELLED" } },
    });
    const finalQty = lines.reduce((s, l) => s + Number(l.qty), 0);
    const finalOrder = await w.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect({
      refusals: codes.filter((c) => c !== "ok" && !c.startsWith("409")),
      finalQtyIsOneWriter: [3, 5].includes(finalQty),
      stock: await w.stockOf(productId),
      orderSubtotal: Number(finalOrder.subtotal),
    }).toEqual({
      refusals: [],
      finalQtyIsOneWriter: true,
      stock: 10 - finalQty,
      orderSubtotal: 5 * finalQty,
    });
    await expectLedgerConsistent(w.tenantId, w.productIds);
  }, 60_000);
});
