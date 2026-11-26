/**
 * SA-1506 PR-1a (SA-1536 Amendment 8: (af) the real entry, the 8.3 round trip, (ag) the COMPLETED stop, (ak) the status-change
 * roles), real Postgres. The order-stock world: a REAL OrdersService over a REAL PrismaService, an order booked the way
 * create() leaves it, then the REAL changeStatus calls (DELIVERED, then CONFIRMED with a reason), then the correction.
 *
 * Test tenant only (qa-sa1506p-*, assertTestTenant in the world). Run: `npm run local:test:db`.
 */
import { describeDb } from "../common/testing/db-spec";
import { buildOrderStockWorld, type OrderStockWorld } from "../inventory/testing/order-stock-world";
import { expectLedgerConsistent } from "../inventory/testing/ledger-consistency";

describeDb("SA-1506 PR-1a: the real reopen path, the round trip, the stop and the roles", () => {
  let w: OrderStockWorld;
  let driverUserId = "";
  let driverId = "";
  const stops: Array<{ route: string; routeStop: string; run: string; stop: string }> = [];

  beforeAll(async () => {
    w = await buildOrderStockWorld("sa1506p", "delivered-line-correction.real-path.db.spec.ts");
    const du = await w.prisma.user.create({
      data: {
        email: `drv-${w.slug}@example.invalid`,
        username: `drv-${w.slug}`,
        role: "DRIVER",
        tenantId: w.tenantId,
      },
    });
    driverUserId = du.id;
    driverId = (
      await w.prisma.driver.create({ data: { userId: du.id, tenantId: w.tenantId } as any })
    ).id;
  }, 120_000);

  afterAll(async () => {
    const swallow = () => undefined;
    if (w) {
      await w.prisma.order
        .updateMany({
          where: { tenantId: w.tenantId },
          data: { routeRunStopId: null, routeRunId: null },
        })
        .catch(swallow);
      await w.prisma.routeRunStop.deleteMany({ where: { tenantId: w.tenantId } }).catch(swallow);
      await w.prisma.routeRun.deleteMany({ where: { tenantId: w.tenantId } }).catch(swallow);
      await w.prisma.routeStop.deleteMany({ where: { tenantId: w.tenantId } }).catch(swallow);
      await w.prisma.route.deleteMany({ where: { tenantId: w.tenantId } }).catch(swallow);
      await w.prisma.driver.deleteMany({ where: { tenantId: w.tenantId } }).catch(swallow);
      await w.prisma.user.deleteMany({ where: { id: driverUserId } }).catch(swallow);
    }
    await w?.cleanup();
  }, 120_000);

  const as = (role: string, sub?: string) => ({
    ...w.jwt,
    role: role as any,
    ...(sub ? { sub } : {}),
  });
  const admin = () => as("TENANT_ADMIN");
  const status = (id: string, to: string, reason?: string, who: any = w.jwt) =>
    w.inTenant(() => w.orders.changeStatus(id, { status: to, ...(reason ? { reason } : {}) }, who));
  const edit = (id: string, items: any[], who: any = admin()) =>
    w.inTenant(() => w.orders.updateOrderItems(id, { replaceAll: false, items }, who));
  const lineOf = (id: string) => w.prisma.orderItem.findFirstOrThrow({ where: { orderId: id } });
  const orderOf = (id: string) => w.prisma.order.findUniqueOrThrow({ where: { id } });
  const net = async (p: string) =>
    (await w.movements(p)).reduce((s: number, m: any) => s + Number(m.quantity), 0);

  it("(af) the REAL path: booked 10, marked DELIVERED, status change to CONFIRMED with a reason, then an admin cut to 8 puts 2 back", async () => {
    const p = await w.product("af", 10);
    const { order, items } = await w.bookOrder({
      status: "CONFIRMED",
      lines: [{ productId: p, qty: 10 }],
    });
    expect(await w.stockOf(p)).toBe(0);

    await status(order.id, "DELIVERED");
    expect(Number((await lineOf(order.id)).deliveredQty)).toBe(10); // the stamp: a manual DELIVERED writes the column
    expect((await orderOf(order.id)).status).toBe("DELIVERED");

    // the entry named by 8.3: the status change DELIVERED -> CONFIRMED, the reason required
    await expect(status(order.id, "CONFIRMED")).rejects.toMatchObject({ status: 400 }); // wrong value: accepted without a reason
    await status(order.id, "CONFIRMED", "office correction: counted 8 on the truck");
    expect((await orderOf(order.id)).status).toBe("CONFIRMED");
    expect(await w.stockOf(p)).toBe(0); // reopening moves no stock

    await edit(order.id, [{ id: items[0].id, qty: 8, correctDelivered: true }]);
    const after = await lineOf(order.id);
    expect([Number(after.qty), Number(after.deliveredQty)]).toEqual([8, 8]);
    expect(await w.stockOf(p)).toBe(2); // wrong value: 0 (master refuses or leaves the 2 on the order)
    expect((await orderOf(order.id)).status).toBe("CONFIRMED");
    expect(
      await w.prisma.auditLog.count({
        where: { tenantId: w.tenantId, action: "order.line-corrected", entityId: order.id },
      }),
    ).toBe(1);
    await expectLedgerConsistent(w.tenantId, [p]);
  }, 120_000);

  it("(af) 8.3 round trip: reopen, a refused correction, the way back (Out for delivery, Delivered): stock nets 0, qty and totals unchanged", async () => {
    const p = await w.product("af-rt", 10);
    const { order, items } = await w.bookOrder({
      status: "CONFIRMED",
      lines: [{ productId: p, qty: 10 }],
    });
    await status(order.id, "DELIVERED");
    const before = await orderOf(order.id);
    const netBefore = await net(p);
    const stockBefore = await w.stockOf(p);

    await status(order.id, "CONFIRMED", "office correction");
    // a refused correction: an operator is LOCKED ROLE (409, nothing written)
    await expect(
      edit(order.id, [{ id: items[0].id, qty: 8, correctDelivered: true }], as("OPERATOR")),
    ).rejects.toMatchObject({ status: 409, response: { code: "LINE_ALREADY_DELIVERED" } });
    // the way back, as the screen does it
    await status(order.id, "OUT_FOR_DELIVERY");
    await status(order.id, "DELIVERED");

    const after = await orderOf(order.id);
    expect(await net(p)).toBe(netBefore); // wrong value: a movement per hop
    expect(await w.stockOf(p)).toBe(stockBefore);
    const line = await lineOf(order.id);
    expect(Number(line.qty)).toBe(10);
    expect([Number(after.subtotal), Number(after.total)]).toEqual([
      Number(before.subtotal),
      Number(before.total),
    ]);
    expect(after.status).toBe("DELIVERED");
    expect(Number(line.deliveredQty)).toBe(10);
    expect(after.deliveredAt).not.toBeNull();
    expect(await w.prisma.deliveryMutation.count({ where: { orderId: order.id } })).toBe(0);
    await expectLedgerConsistent(w.tenantId, [p]);
  }, 120_000);

  /** A DELIVERED order whose stop is COMPLETED (a route delivery). */
  async function deliveredOnCompletedStop(tag: string) {
    const p = await w.product(tag, 10);
    const { order } = await w.bookOrder({
      status: "CONFIRMED",
      lines: [{ productId: p, qty: 10 }],
    });
    await status(order.id, "DELIVERED");
    const route = await w.prisma.route.create({
      data: { name: `${tag} ${w.slug}`, tenantId: w.tenantId } as any,
    });
    const routeStop = await w.prisma.routeStop.create({
      data: {
        tenantId: w.tenantId,
        routeId: route.id,
        stopNumber: 1,
        customerId: w.customerId,
      } as any,
    });
    const run = await w.prisma.routeRun.create({
      data: {
        tenantId: w.tenantId,
        routeId: route.id,
        scheduledDate: new Date("2026-11-20T00:00:00.000Z"),
        status: "COMPLETED" as any,
        driverId,
      },
    });
    const stop = await w.prisma.routeRunStop.create({
      data: {
        tenantId: w.tenantId,
        routeRunId: run.id,
        routeStopId: routeStop.id,
        stopNumber: 1,
        status: "COMPLETED" as any,
      } as any,
    });
    stops.push({ route: route.id, routeStop: routeStop.id, run: run.id, stop: stop.id });
    await w.prisma.order.update({
      where: { id: order.id },
      data: { routeRunId: run.id, routeRunStopId: stop.id },
    });
    return { p, orderId: order.id };
  }

  it("(ag) a COMPLETED stop: the status change DELIVERED -> CONFIRMED is refused for every role (409 ORDER_ROUTE_STOP_COMPLETED for the staff roles), 0 writes", async () => {
    const { p, orderId } = await deliveredOnCompletedStop("ag");
    const snap = async () => ({
      order: (({ status, deliveredAt, notes }) => ({ status, deliveredAt, notes }))(
        await orderOf(orderId),
      ),
      line: Number((await lineOf(orderId)).deliveredQty),
      stock: await w.stockOf(p),
      net: await net(p),
    });
    const before = await snap();
    for (const who of [as("OPERATOR"), as("TENANT_ADMIN")])
      await expect(status(orderId, "CONFIRMED", "reopen", who)).rejects.toMatchObject({
        status: 409,
        response: { code: "ORDER_ROUTE_STOP_COMPLETED" },
      });
    for (const who of [as("CUSTOMER"), as("DRIVER", driverUserId), as("SUPER_ADMIN")])
      await expect(status(orderId, "CONFIRMED", "reopen", who)).rejects.toMatchObject({
        status: expect.any(Number),
      });
    expect(await snap()).toEqual(before);
  }, 120_000);

  it("(ak) the status change DELIVERED -> CONFIRMED is allowed to an OPERATOR and a TENANT_ADMIN only; CUSTOMER, DRIVER and SUPER_ADMIN are refused, 0 writes", async () => {
    for (const who of [as("OPERATOR"), as("TENANT_ADMIN")]) {
      const p = await w.product("ak-ok-" + who.role.slice(0, 3), 10);
      const { order } = await w.bookOrder({
        status: "CONFIRMED",
        lines: [{ productId: p, qty: 10 }],
      });
      await status(order.id, "DELIVERED");
      await status(order.id, "CONFIRMED", "reopen", who);
      expect([who.role, (await orderOf(order.id)).status]).toEqual([who.role, "CONFIRMED"]);
    }
    for (const who of [as("CUSTOMER"), as("DRIVER", driverUserId), as("SUPER_ADMIN")]) {
      const p = await w.product("ak-no-" + who.role.slice(0, 3), 10);
      const { order } = await w.bookOrder({
        status: "CONFIRMED",
        lines: [{ productId: p, qty: 10 }],
      });
      await status(order.id, "DELIVERED");
      const before = await orderOf(order.id);
      await expect(status(order.id, "CONFIRMED", "reopen", who)).rejects.toMatchObject({
        status: 403,
      });
      const after = await orderOf(order.id);
      expect([
        who.role,
        after.status,
        after.notes,
        Number((await lineOf(order.id)).deliveredQty),
      ]).toEqual([who.role, "DELIVERED", before.notes, 10]);
      expect(await w.stockOf(p)).toBe(0);
    }
  }, 120_000);
});
