/**
 * SA-429 (#2377) — real-Postgres pins THROUGH OrdersService.updateOrderItems(): a DRIVER edits an
 * order's items only when the ORDER's own stop belongs to that driver's IN_PROGRESS run and the stop
 * is PENDING or IN_PROGRESS. Every other case — another driver's run, the same driver's SCHEDULED
 * run, a COMPLETED run, a COMPLETED or SKIPPED stop, an order with no stop, and a reassignment
 * committed while the edit waits on the Order lock (two connections) — is the bare 403 with ZERO
 * writes. The 403 also precedes the cancelled-order 400.
 *
 * Builds a REAL OrdersService via `Object.create` (no Nest DI), as orders-inline-return-edit.db.spec.ts
 * does. NOT RUN by the lane that wrote it (DB specs are the prover's): F2's DB lane runs it and adjusts
 * any fixture field the schema demands.
 *
 * SAFETY: one throwaway `qa-2377-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes
 * exactly the rows this run created.
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
import { ForbiddenException, Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "./orders.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { INVOICE_EDIT_STUBS } from "./testing/invoice-edit-stubs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const DENY = "You do not have access to this order";

describeDb(
  "SA-429 (#2377) — a driver edits only an order on their own active run, real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: any;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-2377-${run}`, "driver-edit-access.db.spec.ts");
    let tenantId = "";
    let customerId = "";
    let productId = "";
    let routeId = "";
    const users: string[] = [];
    const drivers: Record<"me" | "other", { userId: string; driverId: string }> = {} as any;
    const runIds: string[] = [];
    const orderIds: string[] = [];
    let stopSeq = 0;

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

    /** An order with one 2-box line, on a stop of a run with the given driver/status/stop status. */
    async function seed(p: {
      runDriver?: "me" | "other" | null;
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
            driverId: p.runDriver === null ? null : drivers[p.runDriver ?? "me"].driverId,
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
          status: (p.orderStatus ?? "CONFIRMED") as any,
          subtotal: "20.00",
          total: "20.00",
          routeRunId,
          routeRunStopId,
          lineItems: {
            create: [{ tenantId, productId, qty: 2, unitPrice: "10.00", subtotal: "20.00" }],
          },
        },
        include: { lineItems: true },
      });
      orderIds.push(o.id);
      return { orderId: o.id, lineId: o.lineItems[0].id, runId: routeRunId };
    }

    const edit = (f: { orderId: string; lineId: string }, who: "me" | "other" = "me") =>
      tenantCtx.run(tenantId, () =>
        orders.updateOrderItems(
          f.orderId,
          { replaceAll: false, items: [{ id: f.lineId, qty: 3 }] },
          asDriver(who),
        ),
      );
    const snapshot = async (orderId: string) => ({
      order: await raw.order.findUniqueOrThrow({ where: { id: orderId } }),
      lines: await raw.orderItem.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } }),
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
          ...INVOICE_EDIT_STUBS,
          reconcileOrderDraftInvoice: async () => undefined,
        },
        logger: new Logger(OrdersService.name),
        inlineReturns: {},
        creditNotes: { settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }) },
      });
      tenantId = (await raw.tenant.create({ data: { slug, name: `2377 ${slug}` } })).id;
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
          data: { userId: buyer.id, businessName: "2377 co", contactName: "Tester", tenantId },
        })
      ).id;
      productId = (
        await raw.product.create({
          data: {
            name: `2377 p ${run}`,
            unit: "each",
            pricePerUnit: "10.00",
            currentStock: "1000",
            tenantId,
          },
        })
      ).id;
      routeId = (await raw.route.create({ data: { name: `2377 route ${run}`, tenantId } as any }))
        .id;
    }, 120_000);

    afterAll(async () => {
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

    it("ALLOWED: the driver's own IN_PROGRESS run with a PENDING stop edits the order", async () => {
      const f = await seed({});
      await edit(f);
      expect(Number((await raw.orderItem.findUniqueOrThrow({ where: { id: f.lineId } })).qty)).toBe(
        3,
      );
    });

    it.each([
      ["another driver's run", { runDriver: "other" as const }],
      ["the same driver's SCHEDULED run", { runStatus: "SCHEDULED" }],
      ["a COMPLETED run", { runStatus: "COMPLETED" }],
      ["a COMPLETED stop", { stopStatus: "COMPLETED" }],
      ["a SKIPPED stop", { stopStatus: "SKIPPED" }],
      ["an order with no stop", { noStop: true }],
    ])("%s ⇒ 403 with zero writes", async (_name, p) => {
      const f = await seed(p);
      const before = await snapshot(f.orderId);
      const err = await edit(f).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.message).toBe(DENY);
      expect(await snapshot(f.orderId)).toEqual(before);
    });

    it("the 403 precedes the cancelled-order 400 (an unassigned driver learns nothing)", async () => {
      const f = await seed({ runDriver: "other", orderStatus: "CANCELLED" });
      await expect(edit(f)).rejects.toMatchObject({ message: DENY });
    });

    it("a reassignment committed while the edit waits on the Order lock ⇒ 403, zero writes (two connections)", async () => {
      const f = await seed({});
      const before = await snapshot(f.orderId);
      let editResult: Promise<unknown> | null = null;
      await raw.$transaction(
        async (t) => {
          await t.$executeRaw`SELECT id FROM "Order" WHERE id = ${f.orderId} FOR UPDATE`;
          // The edit passes its pre-lock check (the run is still ours), then blocks on this lock.
          editResult = edit(f).catch((e) => e);
          await new Promise((r) => setTimeout(r, 800));
          await t.routeRun.update({
            where: { id: f.runId! },
            data: { driverId: drivers.other.driverId },
          });
        },
        { timeout: 15_000 },
      );
      const err = await editResult!;
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as Error).message).toBe(DENY);
      expect(await snapshot(f.orderId)).toEqual(before);
    });
  },
);
