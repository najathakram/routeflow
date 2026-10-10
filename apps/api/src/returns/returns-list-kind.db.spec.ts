/**
 * #2406 (SA-484c), real Postgres — `GET /returns?kind=` end to end THROUGH ReturnsService:
 * an INLINE return (every return the order-detail "Returns on this order" panel records)
 * is invisible on the default (STANDARD) list, appears under `kind: "INLINE"` / `"ALL"` with
 * refundEstimate null + refundEstimateReason "INLINE" (its money is the row's own
 * refundAmount, resolved at capture — never re-priced), and CUSTOMER/DRIVER scoping is
 * unchanged for every kind. Builds a REAL ReturnsService via `Object.create` (no Nest DI),
 * modeled on orders/buyer-edit-cancelled-line.db.spec.ts. NOT RUN by the lane that wrote it
 * (DB specs are the prover's) — F2's DB lane runs it and adjusts any fixture field the
 * schema demands.
 *
 * SAFETY: one throwaway `qa-2406-<run>` tenant approved by `assertTestTenant`; `afterAll`
 * deletes exactly the rows this run created.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { ReturnsService } from "./returns.service";
import { ReturnsController } from "./returns.controller";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("#2406 — GET /returns?kind= scoping and enrichment, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let returns: any;
  let controller: ReturnsController;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-2406-${run}`, "returns-list-kind.db.spec.ts");
  let tenantId = "";

  let customerAUserId = "";
  let customerAId = "";
  let customerBUserId = "";
  let customerBId = "";
  let driverUserId = "";
  let driverId = "";
  const routeIds: string[] = [];
  const runIds: string[] = [];
  const productIds: string[] = [];
  const orderIds: string[] = [];
  const returnIds: string[] = [];

  let orderAId = ""; // customer A, on the driver's route run
  let orderBId = ""; // customer B, NOT on any route run
  let standardReturnId = "";
  let inlineReturnId = "";
  let otherCustomerInlineReturnId = "";

  const principal = (role: "OPERATOR" | "CUSTOMER" | "DRIVER", sub: string): JwtPayload =>
    ({
      sub,
      username: `${role.toLowerCase()}-${run}`,
      role,
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    }) as JwtPayload;
  const operator = () => principal("OPERATOR", "op-sub");
  const customerA = () => principal("CUSTOMER", customerAUserId);
  const driver = () => principal("DRIVER", driverUserId);

  const findAllFor = (user: JwtPayload, options: any = {}) =>
    tenantCtx.run(tenantId, () => returns.findAllForUser(user, options));

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    returns = Object.assign(Object.create(ReturnsService.prototype), { prisma });
    controller = Object.assign(Object.create(ReturnsController.prototype), {
      returnsService: returns,
    });

    tenantId = (await raw.tenant.create({ data: { slug, name: `2406 ${slug}` } })).id;

    customerAUserId = (
      await raw.user.create({
        data: {
          email: `ca-${run}@example.test`,
          username: `ca-${run}`,
          role: "CUSTOMER",
          tenantId,
        },
      })
    ).id;
    customerAId = (
      await raw.customer.create({
        data: {
          userId: customerAUserId,
          businessName: "2406 customer A",
          contactName: "Tester A",
          tenantId,
        },
      })
    ).id;

    customerBUserId = (
      await raw.user.create({
        data: {
          email: `cb-${run}@example.test`,
          username: `cb-${run}`,
          role: "CUSTOMER",
          tenantId,
        },
      })
    ).id;
    customerBId = (
      await raw.customer.create({
        data: {
          userId: customerBUserId,
          businessName: "2406 customer B",
          contactName: "Tester B",
          tenantId,
        },
      })
    ).id;

    driverUserId = (
      await raw.user.create({
        data: { email: `d-${run}@example.test`, username: `d-${run}`, role: "DRIVER", tenantId },
      })
    ).id;
    driverId = (await raw.driver.create({ data: { userId: driverUserId, tenantId } as any })).id;

    const product = await raw.product.create({
      data: {
        name: `2406 widget ${run}`,
        unit: "Each",
        pricePerUnit: "10.00",
        currentStock: "1000",
        tenantId,
      },
    });
    productIds.push(product.id);

    // Driver's own route/run: order A sits on it, order B never does.
    const route = await raw.route.create({ data: { name: `2406 route ${run}`, tenantId } as any });
    routeIds.push(route.id);
    const routeRun = await raw.routeRun.create({
      data: {
        tenantId,
        routeId: route.id,
        scheduledDate: new Date("2026-09-27T00:00:00.000Z"),
        status: "IN_PROGRESS" as any,
        driverId,
      },
    });
    runIds.push(routeRun.id);

    const orderA = await raw.order.create({
      data: {
        customerId: customerAId,
        tenantId,
        status: "DELIVERED" as any,
        subtotal: "0.00",
        total: "0.00",
        routeRunId: routeRun.id,
      },
    });
    orderAId = orderA.id;
    orderIds.push(orderAId);

    const orderB = await raw.order.create({
      data: {
        customerId: customerBId,
        tenantId,
        status: "DELIVERED" as any,
        subtotal: "0.00",
        total: "0.00",
      },
    });
    orderBId = orderB.id;
    orderIds.push(orderBId);

    // One STANDARD return + one INLINE (REFUNDED, refundAmount 14.97) on order A.
    const standardReturn = await raw.return.create({
      data: {
        orderId: orderAId,
        customerId: customerAId,
        reason: "DAMAGED",
        status: "PENDING",
        tenantId,
        kind: "STANDARD",
        items: {
          create: [{ productId: product.id, qty: "1", tenantId }],
        },
      },
    });
    standardReturnId = standardReturn.id;
    returnIds.push(standardReturnId);

    const inlineReturn = await raw.return.create({
      data: {
        orderId: orderAId,
        customerId: customerAId,
        reason: "DAMAGED",
        status: "REFUNDED",
        refundAmount: "14.97",
        tenantId,
        kind: "INLINE",
        items: {
          create: [{ productId: product.id, qty: "1", tenantId, subtotal: "14.97" }],
        },
      },
    });
    inlineReturnId = inlineReturn.id;
    returnIds.push(inlineReturnId);

    // Another customer's INLINE return, on an order off the driver's run.
    const otherInline = await raw.return.create({
      data: {
        orderId: orderBId,
        customerId: customerBId,
        reason: "DAMAGED",
        status: "REFUNDED",
        refundAmount: "5.00",
        tenantId,
        kind: "INLINE",
        items: {
          create: [{ productId: product.id, qty: "1", tenantId, subtotal: "5.00" }],
        },
      },
    });
    otherCustomerInlineReturnId = otherInline.id;
    returnIds.push(otherCustomerInlineReturnId);
  }, 120_000);

  afterAll(async () => {
    await raw.returnItem.deleteMany({ where: { returnId: { in: returnIds } } });
    await raw.return.deleteMany({ where: { id: { in: returnIds } } });
    await raw.order.deleteMany({ where: { id: { in: orderIds } } });
    await raw.routeRun.deleteMany({ where: { id: { in: runIds } } });
    await raw.route.deleteMany({ where: { id: { in: routeIds } } });
    await raw.product.deleteMany({ where: { id: { in: productIds } } });
    await raw.customer.deleteMany({ where: { id: { in: [customerAId, customerBId] } } });
    await raw.driver.deleteMany({ where: { tenantId } });
    await raw.user.deleteMany({
      where: { id: { in: [customerAUserId, customerBUserId, driverUserId] } },
    });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("default (no kind) returns only the STANDARD row", async () => {
    const { data, meta } = await findAllFor(operator(), { orderId: orderAId });
    expect(meta.total).toBe(1);
    expect(data.map((r: any) => r.id)).toEqual([standardReturnId]);
  });

  it("kind: INLINE returns the INLINE row with refundEstimate null and refundAmount 14.97", async () => {
    const { data, meta } = await findAllFor(operator(), { orderId: orderAId, kind: "INLINE" });
    expect(meta.total).toBe(1);
    const row = data[0];
    expect(row.id).toBe(inlineReturnId);
    expect(row.refundEstimate).toBeNull();
    expect(row.refundEstimateReason).toBe("INLINE");
    expect(Number(row.refundAmount)).toBe(14.97);
  });

  it("kind: ALL on order A returns both the STANDARD and INLINE rows", async () => {
    const { data, meta } = await findAllFor(operator(), { orderId: orderAId, kind: "ALL" });
    expect(meta.total).toBe(2);
    expect(data.map((r: any) => r.id).sort()).toEqual([inlineReturnId, standardReturnId].sort());
  });

  it("a bad kind is rejected with 400 through the controller, before the service runs", () => {
    expect(() =>
      controller.findAll(
        operator(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "FOO",
      ),
    ).toThrow(/Invalid kind filter/);
  });

  it("CUSTOMER + ALL excludes the other customer's INLINE row", async () => {
    const { data } = await findAllFor(customerA(), { kind: "ALL" });
    const ids = data.map((r: any) => r.id);
    expect(ids).toEqual(expect.arrayContaining([standardReturnId, inlineReturnId]));
    expect(ids).not.toContain(otherCustomerInlineReturnId);
  });

  it("DRIVER + ALL is route-scoped: a return off the driver's run is excluded", async () => {
    const { data } = await findAllFor(driver(), { kind: "ALL" });
    const ids = data.map((r: any) => r.id);
    expect(ids).toEqual(expect.arrayContaining([standardReturnId, inlineReturnId]));
    expect(ids).not.toContain(otherCustomerInlineReturnId);
  });
});
