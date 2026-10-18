/**
 * B692 (SA-814 R4-3) — real-Postgres pins for the manual PARTIALLY_DELIVERED, through the REAL write path
 * (`updateStatusWithShipMarker`, what changeStatus calls) and the REAL cancel-impact read:
 *  (a) a bare PARTIALLY_DELIVERED is 409 ORDER_PD_NEEDS_QUANTITIES and the status row is unchanged;
 *  (b) `deliveries[]` land as DeliveryMutation rows, `deliveredQty` is recomputed from them, and the cancel
 *      is refused on the delivered part;
 *  (c) a legacy delivered row (all lines 0, no evidence) is flagged `deliveryQuantitiesMissing`, not cancellable;
 *  (d) the DELIVERED path is unchanged (stamps qty, writes no evidence row).
 *
 * NOT RUN by the authoring lane (no Postgres here): the DB lane runs it (`npm run local:test:db`, test
 * tenants only, collected only by jest.db.config.js). One throwaway `qa-pdq-<run>` tenant; `afterAll`
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
import { cancelImpact } from "./order-cancel-impact";
import { updateStatusWithShipMarker } from "./order-ship-state";
import { buildStatusUpdateData } from "./order-status-claim";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("B692 — the office PARTIALLY_DELIVERED quantities on real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-pdq-${run}`, "b692-office-pd-quantities.db.spec.ts");
  let tenantId = "";
  let userId = "";
  let customerId = "";
  let productId = "";
  const orderIds: string[] = [];
  let n = 0;

  async function seed(opts: {
    status: string;
    lines: Array<{ qty: number; d?: number; evidence?: number }>;
  }) {
    n += 1;
    const order = await raw.order.create({
      data: {
        customerId,
        tenantId,
        status: opts.status as never,
        fulfillPath: "PICKUP",
        orderNumber: `PQ${run}-${n}`,
        total: 0,
      },
    });
    orderIds.push(order.id);
    const lineIds: string[] = [];
    for (const l of opts.lines) {
      const li = await raw.orderItem.create({
        data: {
          orderId: order.id,
          productId,
          tenantId,
          qty: l.qty,
          deliveredQty: l.d ?? 0,
          unitPrice: 1,
          subtotal: l.qty,
        },
      });
      lineIds.push(li.id);
      if (l.evidence != null) {
        await raw.deliveryMutation.create({
          data: {
            orderId: order.id,
            orderItemId: li.id,
            productId,
            tenantId,
            type: "PARTIAL",
            quantityDelivered: l.evidence,
          },
        });
      }
    }
    return { orderId: order.id, lineIds };
  }
  const dq = async (lineId: string) =>
    Number((await raw.orderItem.findUnique({ where: { id: lineId } }))!.deliveredQty);
  const statusOf = async (orderId: string) =>
    (await raw.order.findUnique({ where: { id: orderId } }))!.status;

  /** The status write changeStatus makes for a manual move to `to`, with the loose dto a controller passes. */
  const change = (
    orderId: string,
    from: string,
    to: string,
    deliveries?: Array<{ orderItemId: string; quantityDelivered: number }>,
  ) =>
    tenantCtx.run(tenantId, async () => {
      const o = (await raw.order.findUnique({ where: { id: orderId } }))!;
      const dto: Record<string, unknown> = { status: to };
      if (deliveries) dto.deliveries = deliveries;
      return updateStatusWithShipMarker(
        { prisma },
        { ...o, status: from as never } as never,
        dto as never,
        undefined,
        buildStatusUpdateData(o, to as never, { isDeliveredDemotion: false }),
      );
    });
  const impactOf = (orderId: string) =>
    tenantCtx.run(tenantId, () =>
      cancelImpact(
        { prisma, creditNotes: { previewOrderCreditRelease: async () => [] } as never },
        orderId,
      ),
    );

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    tenantId = (await raw.tenant.create({ data: { slug, name: `PDQ ${slug}` } })).id;
    userId = (
      await raw.user.create({
        data: {
          email: `c-${run}@example.test`,
          username: `c-${run}`,
          role: "CUSTOMER",
          tenantId,
        },
      })
    ).id;
    customerId = (
      await raw.customer.create({
        data: { userId, businessName: `Acme Test ${run}`, contactName: "Tester", tenantId },
      })
    ).id;
    productId = (
      await raw.product.create({
        data: { name: `Widget ${run}`, pricePerUnit: 1, unit: "each", tenantId },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await raw.deliveryMutation.deleteMany({ where: { orderId: { in: orderIds } } });
    await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await raw.order.deleteMany({ where: { id: { in: orderIds } } });
    await raw.product.deleteMany({ where: { id: productId } });
    await raw.customer.deleteMany({ where: { id: customerId } });
    await raw.user.deleteMany({ where: { id: userId } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("(a) a bare PARTIALLY_DELIVERED is 409 ORDER_PD_NEEDS_QUANTITIES and the row keeps its status", async () => {
    const { orderId, lineIds } = await seed({
      status: "OUT_FOR_DELIVERY",
      lines: [{ qty: 10 }, { qty: 4 }],
    });
    await expect(change(orderId, "OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED")).rejects.toMatchObject({
      response: { code: "ORDER_PD_NEEDS_QUANTITIES" },
      status: 409,
    });
    expect(await statusOf(orderId)).toBe("OUT_FOR_DELIVERY"); // red on master: PARTIALLY_DELIVERED
    expect(await dq(lineIds[0])).toBe(0);
    expect(await raw.deliveryMutation.count({ where: { orderId } })).toBe(0);
  });

  it("(a) the same order with deliveries that all read 0 is still refused, rows rolled back", async () => {
    const { orderId, lineIds } = await seed({ status: "OUT_FOR_DELIVERY", lines: [{ qty: 5 }] });
    await expect(
      change(orderId, "OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED", [
        { orderItemId: lineIds[0], quantityDelivered: 0 },
      ]),
    ).rejects.toMatchObject({ response: { code: "ORDER_PD_NEEDS_QUANTITIES" } });
    expect(await statusOf(orderId)).toBe("OUT_FOR_DELIVERY");
  });

  it("(b) deliveries[] become evidence rows, deliveredQty is recomputed, the cancel is refused", async () => {
    const { orderId, lineIds } = await seed({
      status: "OUT_FOR_DELIVERY",
      lines: [{ qty: 10 }, { qty: 4 }, { qty: 7 }],
    });
    await change(orderId, "OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED", [
      { orderItemId: lineIds[0], quantityDelivered: 6 },
      { orderItemId: lineIds[1], quantityDelivered: 4 },
    ]);
    expect(await statusOf(orderId)).toBe("PARTIALLY_DELIVERED");
    expect(await dq(lineIds[0])).toBe(6); // red on master: 0
    expect(await dq(lineIds[1])).toBe(4);
    expect(await dq(lineIds[2])).toBe(0); // unnamed: undelivered
    const rows = await raw.deliveryMutation.findMany({
      where: { orderId },
      orderBy: { quantityDelivered: "asc" },
    });
    expect(rows.map((r) => [r.type, Number(r.quantityDelivered), r.routeRunStopId])).toEqual([
      ["DELIVERED", 4, null],
      ["PARTIAL", 6, null],
    ]);
    const impact = await impactOf(orderId);
    expect(impact.deliveredUnits).toBe(10); // red on master: 0
    expect(impact.deliveryQuantitiesMissing).toBe(false);
    expect(impact.canCancel).toBe(false); // red on master: true
  });

  it("(b) a quantity above what is left is a 400 and nothing is written", async () => {
    const { orderId, lineIds } = await seed({ status: "OUT_FOR_DELIVERY", lines: [{ qty: 5 }] });
    await expect(
      change(orderId, "OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED", [
        { orderItemId: lineIds[0], quantityDelivered: 6 },
      ]),
    ).rejects.toMatchObject({ status: 400 });
    expect(await statusOf(orderId)).toBe("OUT_FOR_DELIVERY");
    expect(await raw.deliveryMutation.count({ where: { orderId } })).toBe(0);
  });

  it("(c) a legacy delivered row with no signal is flagged and not cancellable", async () => {
    for (const status of ["PARTIALLY_DELIVERED", "DELIVERED"]) {
      const { orderId } = await seed({ status, lines: [{ qty: 10 }, { qty: 4 }] });
      const impact = await impactOf(orderId);
      expect(impact.deliveryQuantitiesMissing).toBe(true); // red on master: undefined
      expect(impact.canCancel).toBe(false); // red on master: true
    }
  });

  it("(c) any signal lifts it: a stamped line, or a route evidence row", async () => {
    const stamped = await seed({ status: "PARTIALLY_DELIVERED", lines: [{ qty: 10, d: 3 }] });
    expect((await impactOf(stamped.orderId)).deliveryQuantitiesMissing).toBe(false);
    const evidenced = await seed({
      status: "PARTIALLY_DELIVERED",
      lines: [{ qty: 10, evidence: 2 }, { qty: 4 }],
    });
    expect((await impactOf(evidenced.orderId)).deliveryQuantitiesMissing).toBe(false);
  });

  it("(c) an order that has not shipped keeps its cancel", async () => {
    const { orderId } = await seed({ status: "CONFIRMED", lines: [{ qty: 10 }] });
    const impact = await impactOf(orderId);
    expect(impact.deliveryQuantitiesMissing).toBe(false);
    expect(impact.canCancel).toBe(true);
  });

  it("(e) a legacy PD cannot step back to OUT_FOR_DELIVERY to dodge the cancel guard", async () => {
    const { orderId, lineIds } = await seed({
      status: "PARTIALLY_DELIVERED",
      lines: [{ qty: 10 }, { qty: 4 }],
    });
    await expect(change(orderId, "PARTIALLY_DELIVERED", "OUT_FOR_DELIVERY")).rejects.toMatchObject({
      response: { code: "ORDER_DELIVERY_QUANTITIES_MISSING" },
      status: 409,
    });
    expect(await statusOf(orderId)).toBe("PARTIALLY_DELIVERED"); // red on HEAD: OUT_FOR_DELIVERY
    // with deliveries[] the step back stamps them first, and the cancel is then refused on the delivered part
    await change(orderId, "PARTIALLY_DELIVERED", "OUT_FOR_DELIVERY", [
      { orderItemId: lineIds[0], quantityDelivered: 6 },
    ]);
    expect(await statusOf(orderId)).toBe("OUT_FOR_DELIVERY");
    expect(await dq(lineIds[0])).toBe(6);
    expect((await impactOf(orderId)).canCancel).toBe(false);
  });

  it("(d) control: a manual DELIVERED still stamps qty and writes no evidence row", async () => {
    const { orderId, lineIds } = await seed({
      status: "CONFIRMED",
      lines: [{ qty: 10 }, { qty: 4 }],
    });
    await change(orderId, "CONFIRMED", "DELIVERED");
    expect(await statusOf(orderId)).toBe("DELIVERED");
    expect(await dq(lineIds[0])).toBe(10);
    expect(await dq(lineIds[1])).toBe(4);
    expect(await raw.deliveryMutation.count({ where: { orderId } })).toBe(0);
    expect((await impactOf(orderId)).deliveryQuantitiesMissing).toBe(false);
  });
});
