/**
 * SA-434 / SA-434a (#2391) — real-Postgres pins for the two DRIVER paths the SA-429 predicate now guards:
 * `OrdersService.changeStatus` (a driver may only confirm PENDING → CONFIRMED, on an order of their own
 * IN_PROGRESS run with a PENDING/IN_PROGRESS stop) and `ChangeRequestsService.resolve` (decline, and the
 * next-delivery approval's lock → create → lock+claim with compensation).
 *
 * Per path: the allowed case; the six refusal shapes (another driver's run, the same driver's SCHEDULED
 * run, a COMPLETED run, a COMPLETED stop, a SKIPPED stop, no stop) ⇒ the bare 403 with zero writes; the
 * 403 precedes every state error; a reassignment committed while the write waits on the Order lock (two
 * connections) ⇒ 403 (or the CAS 409), zero writes. Next-delivery (SA-434a (3)/(4)): "zero writes" means
 * no surviving rows — the draft is gone and the change request is still PENDING; two concurrent resolves
 * ⇒ one 409, one winner, exactly one draft.
 *
 * Real OrdersService / ChangeRequestsService via `Object.create` (no Nest DI), as
 * orders-inline-return-edit.db.spec.ts does. The next-delivery pins stub `ordersService.create` with a
 * REAL draft-order insert on its own connection (and `deleteOrder` with a real delete): what is under
 * test is resolve's lock, re-derive, CAS claim and compensation, not create(). NOT RUN by the lane that
 * wrote it (DB specs are the prover's): F2's DB lane runs it and adjusts any fixture field the schema
 * demands.
 *
 * SAFETY: one throwaway `qa-2391-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes exactly
 * the rows this run created.
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
import { ConflictException, ForbiddenException, Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "./orders.service";
import { ChangeRequestsService } from "./change-requests.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const DENY = "You do not have access to this order";

describeDb(
  "SA-434 (#2391) — driver confirm and change-request resolve ownership, real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: any;
    let changeRequests: any;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-2391-${run}`, "driver-confirm-resolve.db.spec.ts");
    let tenantId = "";
    let customerId = "";
    let productId = "";
    let routeId = "";
    const users: string[] = [];
    const drivers: Record<"me" | "other", { userId: string; driverId: string }> = {} as any;
    const runIds: string[] = [];
    const orderIds: string[] = [];
    let stopSeq = 0;
    /** Hook for the next-delivery create stub (a reassignment, run on the create's own connection). */
    let afterDraftCreated: (() => Promise<void>) | null = null;

    const asDriver = (who: "me" | "other"): JwtPayload =>
      ({
        sub: drivers[who].userId,
        username: `${who}-${run}`,
        role: "DRIVER",
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId,
        tenantSlug: slug,
      }) as JwtPayload;

    async function seed(p: {
      runDriver?: "me" | "other";
      runStatus?: string;
      stopStatus?: string;
      noStop?: boolean;
      orderStatus?: string;
    }) {
      let routeRunId: string | null = null;
      let routeRunStopId: string | null = null;
      if (!p.noStop) {
        stopSeq += 1;
        const routeStop = await raw.routeStop.create({
          data: { tenantId, routeId, stopNumber: stopSeq, customerId } as any,
        });
        const rr = await raw.routeRun.create({
          data: {
            tenantId,
            routeId,
            scheduledDate: new Date("2026-09-27T00:00:00.000Z"),
            status: (p.runStatus ?? "IN_PROGRESS") as any,
            driverId: drivers[p.runDriver ?? "me"].driverId,
          },
        });
        runIds.push(rr.id);
        const stop = await raw.routeRunStop.create({
          data: {
            tenantId,
            routeRunId: rr.id,
            routeStopId: routeStop.id,
            stopNumber: 1,
            status: (p.stopStatus ?? "PENDING") as any,
          } as any,
        });
        routeRunId = rr.id;
        routeRunStopId = stop.id;
      }
      const o = await raw.order.create({
        data: {
          customerId,
          tenantId,
          status: (p.orderStatus ?? "PENDING") as any,
          subtotal: "20.00",
          total: "20.00",
          routeRunId,
          routeRunStopId,
          lineItems: {
            create: [{ tenantId, productId, qty: 2, unitPrice: "10.00", subtotal: "20.00" }],
          },
        },
      });
      orderIds.push(o.id);
      const cr = await raw.changeRequest.create({
        data: {
          tenantId,
          orderId: o.id,
          productId,
          routeRunStopId,
          type: "ADD_ITEM" as any,
          payload: { productId, qty: 1 },
        },
      });
      return { orderId: o.id, runId: routeRunId, crId: cr.id };
    }

    const confirm = (orderId: string, who: "me" | "other" = "me") =>
      tenantCtx.run(tenantId, () =>
        orders.changeStatus(orderId, { status: "CONFIRMED" }, asDriver(who)),
      );
    const resolve = (
      f: { orderId: string; crId: string },
      action: string,
      who: "me" | "other" = "me",
    ) =>
      tenantCtx.run(tenantId, () =>
        changeRequests.resolve(
          f.orderId,
          f.crId,
          { action, reason: "no room on truck" },
          asDriver(who),
        ),
      );
    const snapshot = async (orderId: string) => ({
      order: await raw.order.findUniqueOrThrow({ where: { id: orderId } }),
      lines: await raw.orderItem.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } }),
      crs: await raw.changeRequest.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } }),
    });
    const draftsFor = () =>
      raw.order.findMany({
        where: { tenantId, customerId, status: "DRAFT" },
        select: { id: true },
      });

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      const systemConfig = new SystemConfigService(
        prisma,
        new EncryptionService({ get: () => undefined } as any),
      );
      orders = Object.assign(Object.create(OrdersService.prototype), {
        prisma,
        gateway: { emitOrderStatusChanged: jest.fn(), emitOrderCreated: jest.fn() },
        systemConfig,
        entitlements: { hasFlag: async () => true },
        sellingRestrictions: {
          getPolicy: async () => ({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
          assertLinesSellable: async () => undefined,
        },
        authGuard: { assertAuthorizedOrThrow: async () => undefined },
        promotionsService: { activeForCatalog: async () => [] },
        tenantCtx,
        invoicesService: {
          revertLinkedInvoicesForOrderEdit: async () => undefined,
          resyncOrderInvoicesForEdit: async () => [],
          reconcileOrderDraftInvoice: async () => undefined,
        },
        notifications: {
          sendToCustomer: async () => undefined,
          sendToDriver: async () => undefined,
        },
        messaging: { notify: async () => [], notifyEvent: async () => undefined },
        logger: new Logger(OrdersService.name),
        inlineReturns: {},
        creditNotes: { settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }) },
      });
      // Next-delivery: resolve's lock/claim/compensation is under test, not create() — a REAL draft
      // insert on the raw connection (a second connection), then the optional reassignment hook.
      const nextDeliveryOrders = Object.assign(Object.create(orders), {
        create: async () => {
          const d = await raw.order.create({
            data: { customerId, tenantId, status: "DRAFT", subtotal: "10.00", total: "10.00" },
          });
          orderIds.push(d.id);
          if (afterDraftCreated) await afterDraftCreated();
          return d;
        },
        assertCreditForProjectedOrder: async () => undefined,
        deleteOrder: async (id: string) => {
          await raw.order.deleteMany({ where: { id } });
        },
      });
      changeRequests = Object.assign(Object.create(ChangeRequestsService.prototype), {
        prisma,
        ordersService: nextDeliveryOrders,
        notifications: {
          sendToCustomer: async () => undefined,
          sendToDriver: async () => undefined,
        },
        authGuard: { assertAuthorizedOrThrow: async () => undefined },
        messaging: { notify: async () => [], notifyEvent: async () => undefined },
      });
      tenantId = (await raw.tenant.create({ data: { slug, name: `2391 ${slug}` } })).id;
      for (const who of ["me", "other"] as const) {
        const u = await raw.user.create({
          data: {
            email: `${who}-${run}@example.test`,
            username: `${who}-${run}`,
            role: "DRIVER",
            tenantId,
          },
        });
        users.push(u.id);
        const d = await raw.driver.create({ data: { userId: u.id, tenantId } as any });
        drivers[who] = { userId: u.id, driverId: d.id };
      }
      const buyer = await raw.user.create({
        data: { email: `b-${run}@example.test`, username: `b-${run}`, role: "CUSTOMER", tenantId },
      });
      users.push(buyer.id);
      customerId = (
        await raw.customer.create({
          data: { userId: buyer.id, businessName: "2391 co", contactName: "Tester", tenantId },
        })
      ).id;
      productId = (
        await raw.product.create({
          data: {
            name: `2391 p ${run}`,
            unit: "each",
            pricePerUnit: "10.00",
            currentStock: "1000",
            tenantId,
          },
        })
      ).id;
      routeId = (await raw.route.create({ data: { name: `2391 route ${run}`, tenantId } as any }))
        .id;
    }, 120_000);

    beforeEach(() => {
      afterDraftCreated = null;
    });

    afterAll(async () => {
      await raw.changeRequest.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.orderRevision?.deleteMany?.({ where: { orderId: { in: orderIds } } });
      await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.order.deleteMany({ where: { id: { in: orderIds } } });
      await raw.routeRunStop.deleteMany({ where: { routeRunId: { in: runIds } } });
      await raw.routeRun.deleteMany({ where: { id: { in: runIds } } });
      await raw.routeStop.deleteMany({ where: { routeId } });
      await raw.route.deleteMany({ where: { id: routeId } });
      await raw.stockMovement.deleteMany({ where: { productId } });
      await raw.product.deleteMany({ where: { id: productId } });
      await raw.customer.deleteMany({ where: { id: customerId } });
      await raw.driver.deleteMany({ where: { tenantId } });
      await raw.user.deleteMany({ where: { id: { in: users } } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    const REFUSALS: Array<[string, Parameters<typeof seed>[0]]> = [
      ["another driver's run", { runDriver: "other" }],
      ["the same driver's SCHEDULED run", { runStatus: "SCHEDULED" }],
      ["a COMPLETED run", { runStatus: "COMPLETED" }],
      ["a COMPLETED stop", { stopStatus: "COMPLETED" }],
      ["a SKIPPED stop", { stopStatus: "SKIPPED" }],
      ["an order with no stop", { noStop: true }],
    ];

    describe("changeStatus (a driver confirms PENDING → CONFIRMED)", () => {
      it("ALLOWED: own IN_PROGRESS run, PENDING stop", async () => {
        const f = await seed({});
        await confirm(f.orderId);
        expect((await raw.order.findUniqueOrThrow({ where: { id: f.orderId } })).status).toBe(
          "CONFIRMED",
        );
      });

      it.each(REFUSALS)("%s ⇒ 403, zero writes", async (_n, p) => {
        const f = await seed(p);
        const before = await snapshot(f.orderId);
        await expect(confirm(f.orderId)).rejects.toMatchObject({ message: DENY });
        expect(await snapshot(f.orderId)).toEqual(before);
      });

      it("the 403 precedes the state error (a foreign driver on a CONFIRMED order)", async () => {
        const f = await seed({ runDriver: "other", orderStatus: "CONFIRMED" });
        await expect(confirm(f.orderId)).rejects.toMatchObject({ message: DENY });
      });

      it("a reassignment committed while the confirm waits on the Order lock ⇒ 403, zero writes", async () => {
        const f = await seed({});
        const before = await snapshot(f.orderId);
        let pending: Promise<unknown> | null = null;
        await raw.$transaction(
          async (t) => {
            await t.$executeRaw`SELECT id FROM "Order" WHERE id = ${f.orderId} FOR UPDATE`;
            pending = confirm(f.orderId).catch((e) => e);
            await new Promise((r) => setTimeout(r, 800));
            await t.routeRun.update({
              where: { id: f.runId! },
              data: { driverId: drivers.other.driverId },
            });
          },
          { timeout: 15_000 },
        );
        const err = await pending!;
        expect(err).toBeInstanceOf(ForbiddenException);
        expect(await snapshot(f.orderId)).toEqual(before);
      });

      it("the order leaving PENDING while the confirm waits ⇒ the CAS 409 ORDER_CHANGED_DURING_EDIT", async () => {
        const f = await seed({});
        let pending: Promise<unknown> | null = null;
        await raw.$transaction(
          async (t) => {
            await t.$executeRaw`SELECT id FROM "Order" WHERE id = ${f.orderId} FOR UPDATE`;
            pending = confirm(f.orderId).catch((e) => e);
            await new Promise((r) => setTimeout(r, 800));
            await t.order.update({ where: { id: f.orderId }, data: { status: "CANCELLED" } });
          },
          { timeout: 15_000 },
        );
        const err: any = await pending!;
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.getResponse()).toMatchObject({ code: "ORDER_CHANGED_DURING_EDIT" });
        expect((await raw.order.findUniqueOrThrow({ where: { id: f.orderId } })).status).toBe(
          "CANCELLED",
        );
      });
    });

    describe("resolve (DECLINE)", () => {
      it("ALLOWED: own IN_PROGRESS run declines", async () => {
        const f = await seed({ orderStatus: "OUT_FOR_DELIVERY" });
        await resolve(f, "DECLINE");
        expect((await raw.changeRequest.findUniqueOrThrow({ where: { id: f.crId } })).status).toBe(
          "DECLINED",
        );
      });

      it.each(REFUSALS)("%s ⇒ 403, zero writes", async (_n, p) => {
        const f = await seed({ ...p, orderStatus: "OUT_FOR_DELIVERY" });
        const before = await snapshot(f.orderId);
        await expect(resolve(f, "DECLINE")).rejects.toMatchObject({ message: DENY });
        expect(await snapshot(f.orderId)).toEqual(before);
      });

      it("the 403 precedes 'Change request not found'", async () => {
        const f = await seed({ runDriver: "other", orderStatus: "OUT_FOR_DELIVERY" });
        await expect(
          resolve({ orderId: f.orderId, crId: randomUUID() }, "DECLINE"),
        ).rejects.toMatchObject({
          message: DENY,
        });
      });
    });

    describe("resolve (APPROVE_NEXT_DELIVERY) — lock → create → lock + CAS claim, with compensation", () => {
      it("a reassignment committed between create and claim ⇒ 403, the draft gone, the CR still PENDING", async () => {
        const f = await seed({ orderStatus: "OUT_FOR_DELIVERY" });
        const draftsBefore = await draftsFor();
        afterDraftCreated = async () => {
          await raw.routeRun.update({
            where: { id: f.runId! },
            data: { driverId: drivers.other.driverId },
          });
        };
        await expect(resolve(f, "APPROVE_NEXT_DELIVERY")).rejects.toMatchObject({ message: DENY });
        expect(await draftsFor()).toEqual(draftsBefore);
        expect((await raw.changeRequest.findUniqueOrThrow({ where: { id: f.crId } })).status).toBe(
          "PENDING",
        );
      });

      it("two concurrent resolves ⇒ exactly one winner, one 409, exactly one surviving draft", async () => {
        const f = await seed({ orderStatus: "OUT_FOR_DELIVERY" });
        const draftsBefore = (await draftsFor()).length;
        const results = await Promise.all([
          resolve(f, "APPROVE_NEXT_DELIVERY").catch((e) => e),
          resolve(f, "APPROVE_NEXT_DELIVERY").catch((e) => e),
        ]);
        const errors = results.filter((r) => r instanceof Error);
        expect(errors).toHaveLength(1);
        expect((errors[0] as ConflictException).getResponse()).toMatchObject({
          code: "CHANGE_REQUEST_ALREADY_RESOLVED",
        });
        expect((await draftsFor()).length).toBe(draftsBefore + 1);
        const cr = await raw.changeRequest.findUniqueOrThrow({ where: { id: f.crId } });
        expect(cr.status).toBe("APPROVED");
        expect(cr.nextOrderId).not.toBeNull();
      });
    });
  },
);
