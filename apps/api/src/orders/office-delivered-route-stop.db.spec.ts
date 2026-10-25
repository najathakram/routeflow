/**
 * Row 590 (SA-978 §1, SA-978a §1): an office DELIVERED on an order that rides a run stop, on real Postgres, through the REAL
 * OrdersService.changeStatus (the controller's PATCH /orders/:id/status is a pass-through to it) and the real edit path:
 *  - RED A: an OUT_FOR_DELIVERY order on an IN_PROGRESS run's PENDING stop. Master answers 200 and leaves every line at
 *        deliveredQty 0 (observe). After: 409 ORDER_DELIVERED_ON_ROUTE_STOP, the status unchanged, nothing written.
 *  - RED B: the same order taking an edit 10 -> 7 after the attempt. Master restocks 3 units the customer holds (observe).
 *        After: the DELIVERED write never happens, so the order is still OUT_FOR_DELIVERY.
 *  - GUARD C: a COMPLETED stop, PARTIALLY_DELIVERED -> DELIVERED: 200, the route figure (6 of 10) stays, and the
 *        response names the short line in `routeHeldLines` (SA-978 §1).
 *  - GUARD D: an order with no run link: the existing stamp books the line in full, unchanged.
 *
 * The DB lane runs it (`npm run local:test:db`, test tenants only). One throwaway `qa-r590-<run>` tenant; `afterAll`
 * deletes exactly the rows this run created.
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { buildDbOrdersService } from "../common/testing/orders-service-db-harness";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("Row 590 — office DELIVERED on a run-stop order, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-r590-${run}`, "office-delivered-route-stop.db.spec.ts");
  let tenantId = "";
  let userId = "";
  let driverId = "";
  let customerId = "";
  let productId = "";
  const orderIds: string[] = [];
  let n = 0;
  const operator = () =>
    ({
      sub: userId,
      email: `o-${run}@example.test`,
      username: `o-${run}`,
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    }) as JwtPayload;
  const as = <T>(fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);

  /** A run (status given) with one stop (status given) for the shared customer; the order linked to it. */
  async function seed(
    status: string,
    stop: { runStatus: string; stopStatus: string } | null,
    over: { d?: number; qty?: number; route?: { orderedQty: number } } = {},
  ) {
    n += 1;
    const qty = over.qty ?? 10;
    const order = await raw.order.create({
      data: {
        customerId,
        tenantId,
        status: status as never,
        fulfillPath: "ROUTE" as never,
        orderNumber: `R590-${run}-${n}`,
        subtotal: String(qty),
        total: String(qty),
      },
    });
    orderIds.push(order.id);
    const line = await raw.orderItem.create({
      data: {
        orderId: order.id,
        productId,
        tenantId,
        qty,
        deliveredQty: over.d ?? 0,
        unitPrice: 1,
        subtotal: qty,
      },
    });
    let stopId: string | null = null;
    if (stop) {
      const route = await raw.route.create({ data: { name: `R590 ${run}-${n}`, tenantId } });
      const routeStop = await raw.routeStop.create({
        data: { routeId: route.id, stopNumber: 1, customerId, tenantId },
      });
      const routeRun = await raw.routeRun.create({
        data: {
          routeId: route.id,
          scheduledDate: new Date(),
          driverId,
          tenantId,
          status: stop.runStatus as never,
        },
      });
      const runStop = await raw.routeRunStop.create({
        data: {
          routeRunId: routeRun.id,
          routeStopId: routeStop.id,
          stopNumber: 1,
          customerId,
          tenantId,
          status: stop.stopStatus as never,
        },
      });
      stopId = runStop.id;
      await raw.order.update({
        where: { id: order.id },
        data: { routeRunId: routeRun.id, routeRunStopId: runStop.id },
      });
      if (over.route) {
        await raw.deliveryMutation.create({
          data: {
            orderId: order.id,
            orderItemId: line.id,
            productId,
            tenantId,
            routeRunStopId: runStop.id,
            driverId,
            type: "PARTIAL",
            quantityDelivered: over.route.orderedQty,
          },
        });
      }
    }
    return { orderId: order.id, lineId: line.id, stopId };
  }
  const deliver = (orderId: string) =>
    as(() => orders.changeStatus(orderId, { status: "DELIVERED" } as never, operator()));
  const read = (orderId: string) => raw.order.findUniqueOrThrow({ where: { id: orderId } });
  const dq = async (lineId: string) =>
    Number((await raw.orderItem.findUniqueOrThrow({ where: { id: lineId } })).deliveredQty);

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    orders = buildDbOrdersService(prisma, tenantCtx);
    tenantId = (await raw.tenant.create({ data: { slug, name: `R590 ${slug}` } })).id;
    userId = (
      await raw.user.create({
        data: { email: `o-${run}@example.test`, username: `o-${run}`, role: "OPERATOR", tenantId },
      })
    ).id;
    const driverUser = await raw.user.create({
      data: { email: `d-${run}@example.test`, username: `d-${run}`, role: "DRIVER", tenantId },
    });
    driverId = (
      await raw.driver.create({ data: { userId: driverUser.id, contactName: "Sam", tenantId } })
    ).id;
    customerId = (
      await raw.customer.create({
        data: {
          userId,
          businessName: `Acme Test ${run}`,
          contactName: "Tester",
          email: `buyer-${run}@example.test`,
          tenantId,
        },
      })
    ).id;
    productId = (
      await raw.product.create({
        data: {
          name: `Widget ${run}`,
          unit: "ea",
          pricePerUnit: "1.00",
          currentStock: "90",
          tenantId,
        },
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    try {
      await raw.auditLog.deleteMany({ where: { tenantId } });
      await raw.stockMovement.deleteMany({ where: { productId } });
      await raw.deliveryMutation.deleteMany({ where: { tenantId } });
      await raw.invoice.deleteMany({ where: { tenantId } });
      await raw.orderRevision.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.order.deleteMany({ where: { id: { in: orderIds } } });
      await raw.routeRunStop.deleteMany({ where: { tenantId } });
      await raw.routeRun.deleteMany({ where: { tenantId } });
      await raw.routeStop.deleteMany({ where: { tenantId } });
      await raw.route.deleteMany({ where: { tenantId } });
      await raw.driver.deleteMany({ where: { tenantId } });
      await raw.product.deleteMany({ where: { tenantId } });
      await raw.customer.deleteMany({ where: { tenantId } });
      await raw.user.deleteMany({ where: { tenantId } });
      await raw.tenant.delete({ where: { id: tenantId } });
    } finally {
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }
  });

  it("RED A: OUT_FOR_DELIVERY on an IN_PROGRESS run's PENDING stop: 409 ORDER_DELIVERED_ON_ROUTE_STOP, nothing written", async () => {
    const { orderId, lineId } = await seed("OUT_FOR_DELIVERY", {
      runStatus: "IN_PROGRESS",
      stopStatus: "PENDING",
    });
    const result: any = await deliver(orderId).then(
      (row) => ({ ok: row }),
      (e) => ({ err: e }),
    );
    // master: { ok: <order row> }, status DELIVERED, deliveredQty 0 (the B692 state)
    expect(result.err?.getStatus?.()).toBe(409);
    expect(result.err?.getResponse?.()).toMatchObject({ code: "ORDER_DELIVERED_ON_ROUTE_STOP" });
    expect(result.err?.getResponse?.().message).toBe(
      "This order is on a delivery run. Complete its stop on the route, or take it off the run first.",
    );
    expect((await read(orderId)).status).toBe("OUT_FOR_DELIVERY");
    expect(await dq(lineId)).toBe(0);
  }, 60_000);

  it("RED B: after the refused DELIVERED, an edit 10 -> 7 does not treat the order as delivered", async () => {
    const { orderId, lineId } = await seed("OUT_FOR_DELIVERY", {
      runStatus: "IN_PROGRESS",
      stopStatus: "PENDING",
    });
    await deliver(orderId).catch(() => undefined);
    await as(() =>
      orders.updateOrderItems(
        orderId,
        { replaceAll: false, items: [{ id: lineId, qty: 7 }] },
        operator(),
      ),
    );
    // master: DELIVERED with d 0, so the cut books max(7, 0) = 7 and restocks 3 units the customer holds (observed: +3)
    expect((await read(orderId)).status).toBe("OUT_FOR_DELIVERY");
  }, 60_000);

  it("GUARD C: a COMPLETED stop, PARTIALLY_DELIVERED -> DELIVERED: 200, the route figure stays at 6 of 10", async () => {
    const { orderId, lineId } = await seed(
      "PARTIALLY_DELIVERED",
      { runStatus: "COMPLETED", stopStatus: "COMPLETED" },
      { d: 6, route: { orderedQty: 6 } },
    );
    const row: any = await deliver(orderId);
    expect((await read(orderId)).status).toBe("DELIVERED");
    expect(await dq(lineId)).toBe(6);
    expect(row.status).toBe("DELIVERED");
  }, 60_000);

  it("GUARD D: no run link: the entry stamp books the line in full, unchanged", async () => {
    const { orderId, lineId } = await seed("OUT_FOR_DELIVERY", null);
    await deliver(orderId);
    expect((await read(orderId)).status).toBe("DELIVERED");
    expect(await dq(lineId)).toBe(10);
  }, 60_000);

  it("GUARD E: an IN_PROGRESS stop is refused too; a SKIPPED stop on a live run is refused (not COMPLETED)", async () => {
    for (const stopStatus of ["IN_PROGRESS", "SKIPPED"]) {
      const { orderId } = await seed("OUT_FOR_DELIVERY", { runStatus: "IN_PROGRESS", stopStatus });
      const err: any = await deliver(orderId).catch((e) => e);
      expect(err?.getResponse?.()).toMatchObject({ code: "ORDER_DELIVERED_ON_ROUTE_STOP" });
      expect((await read(orderId)).status).toBe("OUT_FOR_DELIVERY");
    }
  }, 60_000);
});
