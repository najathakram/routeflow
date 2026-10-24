/**
 * Row 587 (builder A head 650c19ac8) real-Postgres twin: the office marker is the row's origin (no route stop,
 * no driver, a DELIVERED/PARTIAL type), never its free-text note. An office PARTIAL row a clerk annotated
 * ("left at back door") completes under PARTIALLY_DELIVERED -> DELIVERED (6 of 10 -> 10: one remainder row of 4,
 * one audit row), and a ROUTE row carrying a note does not (stays 6, no remainder, no audit).
 * Collected only by jest.db.config.js. One throwaway `qa-office-<run>` tenant; `afterAll` deletes its rows.
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
import { updateStatusWithShipMarker } from "./order-ship-state";
import { buildStatusUpdateData } from "./order-status-claim";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("Row 587 office completion: an office row with a clerk note — real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-office-${run}`, "office-row-clerk-note.db.spec.ts");
  let tenantId = "";
  let userId = "";
  let customerId = "";
  let productId = "";
  const orderIds: string[] = [];
  let n = 0;
  let routeId = "";
  let runId = "";
  let routeStopId = "";
  let runStopId = "";

  /** A real route stop for the ROUTE evidence rows: every route writer sets routeRunStopId (row 587 review). */
  async function ensureRunStop() {
    if (runStopId) return runStopId;
    routeId = (await raw.route.create({ data: { name: `Office route ${run}`, tenantId } })).id;
    routeStopId = (await raw.routeStop.create({ data: { routeId, stopNumber: 1, tenantId } })).id;
    runId = (
      await raw.routeRun.create({
        data: { routeId, scheduledDate: new Date(), status: "COMPLETED", tenantId },
      })
    ).id;
    runStopId = (
      await raw.routeRunStop.create({
        data: { routeRunId: runId, routeStopId, stopNumber: 1, podPhotoUrls: [], tenantId },
      })
    ).id;
    return runStopId;
  }

  /** An order with lines [{qty, d}] (and optionally route evidence on the line at that index). */
  async function seed(opts: {
    status?: string;
    lines: Array<{ qty: number; d?: number; evidence?: number; note?: string; route?: boolean }>;
  }) {
    n += 1;
    const order = await raw.order.create({
      data: {
        customerId,
        tenantId,
        status: (opts.status ?? "CONFIRMED") as never,
        fulfillPath: "PICKUP",
        orderNumber: `OF${run}-${n}`,
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
            routeRunStopId: l.route ? await ensureRunStop() : null,
            driverId: null,
            type: "PARTIAL",
            quantityDelivered: l.evidence,
            note: l.note ?? null,
          },
        });
      }
    }
    return { orderId: order.id, lineIds };
  }
  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    tenantId = (await raw.tenant.create({ data: { slug, name: `Office ${slug}` } })).id;
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
    await raw.auditLog.deleteMany({ where: { tenantId } });
    await raw.auditLog.deleteMany({ where: { entityId: { in: orderIds } } });
    await raw.deliveryMutation.deleteMany({ where: { orderId: { in: orderIds } } });
    await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await raw.order.deleteMany({ where: { id: { in: orderIds } } });
    if (runStopId) await raw.routeRunStop.deleteMany({ where: { id: runStopId } });
    if (runId) await raw.routeRun.deleteMany({ where: { id: runId } });
    if (routeStopId) await raw.routeStop.deleteMany({ where: { id: routeStopId } });
    if (routeId) await raw.route.deleteMany({ where: { id: routeId } });
    await raw.product.deleteMany({ where: { id: productId } });
    await raw.customer.deleteMany({ where: { id: customerId } });
    await raw.user.deleteMany({ where: { id: userId } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  const dq = async (lineId: string) =>
    Number((await raw.orderItem.findUnique({ where: { id: lineId } }))!.deliveredQty);
  const pdToDelivered = (orderId: string) =>
    tenantCtx.run(tenantId, async () => {
      const o = (await raw.order.findUnique({ where: { id: orderId } }))!;
      return updateStatusWithShipMarker(
        { prisma },
        o as never,
        { status: "DELIVERED" as never },
        undefined,
        buildStatusUpdateData(o, "DELIVERED" as never, { isDeliveredDemotion: false }),
      );
    });
  const rowsOf = (lineId: string) =>
    raw.deliveryMutation.findMany({
      where: { orderItemId: lineId },
      orderBy: { createdAt: "asc" },
    });
  const auditsOf = (orderId: string) =>
    raw.auditLog.findMany({
      where: { entityId: orderId, action: AUDIT_ACTIONS.ORDER_LINE_OFFICE_COMPLETED },
    });

  it("REG: an office row with a clerk note completes under PD -> DELIVERED: 6/10 -> 10, remainder row 4, one audit row", async () => {
    const { orderId, lineIds } = await seed({
      status: "PARTIALLY_DELIVERED",
      lines: [{ qty: 10, d: 6, evidence: 6, note: "left at back door, signed by clerk" }],
    });
    await pdToDelivered(orderId);
    expect(await dq(lineIds[0])).toBe(10);
    const rows = await rowsOf(lineIds[0]);
    expect(
      rows.map((r) => [r.type, Number(r.quantityDelivered), r.routeRunStopId, r.note]),
    ).toEqual([
      ["PARTIAL", 6, null, "left at back door, signed by clerk"],
      ["DELIVERED", 4, null, "OFFICE_MARKED"],
    ]);
    const audits = await auditsOf(orderId);
    expect(audits).toHaveLength(1);
    expect((audits[0].meta as any)?.summary).toBe(`line ${lineIds[0]}: 6 -> 10, office completion`);
  }, 60_000);

  it("control: a ROUTE row with a note does not complete (stays 6, no remainder row, no audit)", async () => {
    const { orderId, lineIds } = await seed({
      status: "PARTIALLY_DELIVERED",
      lines: [{ qty: 10, d: 6, evidence: 6, note: "customer short on cash", route: true }],
    });
    await pdToDelivered(orderId);
    expect(await dq(lineIds[0])).toBe(6);
    expect((await rowsOf(lineIds[0])).map((r) => [r.type, Number(r.quantityDelivered)])).toEqual([
      ["PARTIAL", 6],
    ]);
    expect(await auditsOf(orderId)).toHaveLength(0);
  }, 60_000);
});
