/**
 * SA-763r R6 / M2 — real-Postgres pins for the delivered stamp, through the REAL write paths: the manual
 * DELIVERED status write (`updateStatusWithShipMarker`, what changeStatus calls), the counter sale's DELIVERED
 * write (`markSaleDelivered`), the stable-id edit and the replace-all (recreated) edit of a DELIVERED order,
 * and the reopen -> cancel-impact refusal. A line with a DeliveryMutation row keeps its route evidence;
 * a recorded value is never lowered (the routeRunStopId guard is covered by the unit specs).
 *
 * NOT RUN by the authoring lane (no Postgres here): the DB lane runs it (`npm run local:test:db`, test
 * tenants only, collected only by jest.db.config.js). One throwaway `qa-stamp-<run>` tenant; `afterAll`
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
import {
  captureRecreatedCarry,
  markSaleDelivered,
  stampDeliveredAfterEdit,
  stampDeliveredInFull,
} from "./delivered-stamp";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("SA-763r — the delivered stamp on real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-stamp-${run}`, "delivered-stamp.db.spec.ts");
  let tenantId = "";
  let userId = "";
  let customerId = "";
  let productId = "";
  const orderIds: string[] = [];
  let n = 0;

  /** An order with lines [{qty, d}] (and optionally route evidence on the line at that index). */
  async function seed(opts: {
    status?: string;
    lines: Array<{ qty: number; d?: number; evidence?: number }>;
  }) {
    n += 1;
    const order = await raw.order.create({
      data: {
        customerId,
        tenantId,
        status: (opts.status ?? "CONFIRMED") as never,
        fulfillPath: "PICKUP",
        orderNumber: `ST${run}-${n}`,
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

  const manualDelivered = (orderId: string, from: string) =>
    tenantCtx.run(tenantId, async () => {
      const o = (await raw.order.findUnique({ where: { id: orderId } }))!;
      return updateStatusWithShipMarker(
        { prisma },
        { ...o, status: from as never } as never,
        { status: "DELIVERED" as never },
        undefined,
        buildStatusUpdateData(o, "DELIVERED" as never, { isDeliveredDemotion: false }),
      );
    });

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    tenantId = (await raw.tenant.create({ data: { slug, name: `Stamp ${slug}` } })).id;
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

  it("(4) a manual DELIVERED stamps a no-row line: 0 -> qty, in the same transaction as the status", async () => {
    const { orderId, lineIds } = await seed({ lines: [{ qty: 10 }, { qty: 4 }] });
    await manualDelivered(orderId, "CONFIRMED");
    expect((await raw.order.findUnique({ where: { id: orderId } }))!.status).toBe("DELIVERED");
    expect(await dq(lineIds[0])).toBe(10);
    expect(await dq(lineIds[1])).toBe(4);
  });

  it("(4) the counter sale's DELIVERED write stamps too", async () => {
    const { orderId, lineIds } = await seed({ lines: [{ qty: 3 }] });
    await tenantCtx.run(tenantId, () => markSaleDelivered(prisma, orderId, new Date()));
    expect(await dq(lineIds[0])).toBe(3);
  });

  it("(5) a short-delivered route line (rows) keeps its evidence; qty < delivered is never lowered", async () => {
    const { orderId, lineIds } = await seed({
      status: "PARTIALLY_DELIVERED",
      lines: [{ qty: 10, d: 6, evidence: 6 }, { qty: 2 }, { qty: 4, d: 10 }],
    });
    await manualDelivered(orderId, "PARTIALLY_DELIVERED");
    expect(await dq(lineIds[0])).toBe(6);
    expect(await dq(lineIds[1])).toBe(2);
    expect(await dq(lineIds[2])).toBe(10);
    expect(await raw.deliveryMutation.count({ where: { orderId } })).toBe(1);
  });

  it("(6) +2 on a DELIVERED no-row line raises d by exactly 2; a route short line is unchanged", async () => {
    const { orderId, lineIds } = await seed({
      status: "DELIVERED",
      lines: [
        { qty: 12, d: 10 },
        { qty: 12, d: 6, evidence: 6 },
      ],
    });
    await tenantCtx.run(tenantId, () =>
      prisma.tenantTransaction((tx: any) =>
        stampDeliveredAfterEdit(
          tx,
          orderId,
          [
            { id: lineIds[0], productId, qty: 10 },
            { id: lineIds[1], productId, qty: 10 },
          ],
          "stable",
        ),
      ),
    );
    expect(await dq(lineIds[0])).toBe(12);
    expect(await dq(lineIds[1])).toBe(6);
  });

  it("(6) a replace-all carries the product's delivered sum onto the recreated row (M2)", async () => {
    const { orderId, lineIds } = await seed({ status: "DELIVERED", lines: [{ qty: 10, d: 10 }] });
    await tenantCtx.run(tenantId, () =>
      prisma.tenantTransaction(async (tx: any) => {
        const held = [{ id: lineIds[0], productId, qty: 10, deliveredQty: 10 }];
        const carry = await captureRecreatedCarry(tx, orderId, held);
        await tx.orderItem.deleteMany({ where: { orderId } });
        await tx.orderItem.create({
          data: { orderId, productId, tenantId, qty: 12, unitPrice: 1, subtotal: 12 },
        });
        await stampDeliveredInFull(tx, orderId, "recreated", carry!);
      }),
    );
    const rows = await raw.orderItem.findMany({ where: { orderId } });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].deliveredQty)).toBe(12);
  });

  it("(7) manual DELIVERED -> reopen -> cancel-impact: canCancel is false (the stamp stays)", async () => {
    const { orderId, lineIds } = await seed({ lines: [{ qty: 10 }] });
    await manualDelivered(orderId, "CONFIRMED");
    await tenantCtx.run(tenantId, async () => {
      const o = (await raw.order.findUnique({ where: { id: orderId } }))!;
      await updateStatusWithShipMarker(
        { prisma },
        { ...o, status: "DELIVERED" as never } as never,
        { status: "CONFIRMED" as never, reason: "reopen" },
        undefined,
        buildStatusUpdateData(o, "CONFIRMED" as never, { isDeliveredDemotion: true }),
      );
    });
    expect(await dq(lineIds[0])).toBe(10);
    const impact = await tenantCtx.run(tenantId, () =>
      cancelImpact(
        { prisma, creditNotes: { previewOrderCreditRelease: async () => [] } as never },
        orderId,
      ),
    );
    expect(impact.deliveredUnits).toBe(10);
    expect(impact.canCancel).toBe(false);
  });
});
