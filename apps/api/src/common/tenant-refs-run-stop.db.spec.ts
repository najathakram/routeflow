/**
 * B1106 / SA-1105 PR B against real Postgres and two real tenants: tenant B's route-run and route-run-stop ids, sent as tenant
 * A, are refused with the same 404 as a missing id, and NOTHING is written. The FK alone is no tenant proof (a foreign id
 * exists, so the FK is satisfied). One case per writer the inventory lists as NEEDS_PROOF:
 *   1. DriversService.recordLocation           (runId; every caller)
 *   2. MessagesService.create                  (runId; the OPERATOR / TENANT_ADMIN path returns before any read)
 *   4. OrdersService.create                    (routeRunId / routeRunStopId; staff path; also the order's inline return stop)
 *   7. InlineReturnsService.capture            (routeRunStopId; staff path)
 * plus the helper's two new kinds. A legacy NULL-tenant run cannot be seeded here: `RouteRun_tenantId_nn` refuses a new row
 * with no tenant. The helper reads through `forTenant()`, which never matches a null `tenantId`, so such a row is refused too.
 * Throwaway `qa-b1106-*` tenants (approved test-tenant shape). Collected only by `jest.db.config.js` (`npm run local:test:db`);
 * `requireLocalDatabaseUrl()` refuses any non-local host.
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
import { Logger, NotFoundException } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "./encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { NumberingService } from "../import/numbering.service";
import { IdempotencyService } from "./idempotency.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { InlineReturnsQuoteService } from "../returns/inline-returns-quote.service";
import { InlineReturnsService } from "../returns/inline-returns.service";
import { OrdersService } from "../orders/orders.service";
import { DriversService } from "../drivers/drivers.service";
import { MessagesService } from "../messages/messages.service";
import { assertRefsInTenant } from "./assert-refs-in-tenant";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

type World = {
  tenantId: string;
  slug: string;
  opId: string;
  driverUserId: string;
  customerId: string;
  productId: string;
  runId: string;
  stopId: string;
};

describeDb(
  "B1106 PR B: foreign run and stop ids are refused and nothing is written - real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient; // superuser fixture client, deliberately unscoped
    let prisma: PrismaService;
    let ctx: TenantContextService;
    let orders: any;
    let inlineSvc: any;
    let drivers: DriversService;
    let messages: MessagesService;
    let a: World;
    let b: World;
    const tenantIds: string[] = [];

    async function world(label: string): Promise<World> {
      const slug = assertTestTenant(`qa-b1106-${RUN}-${label}`, "tenant-refs-run-stop.db.spec.ts");
      const tenant = await raw.tenant.create({ data: { slug, name: `B1106 ${slug}` } });
      tenantIds.push(tenant.id);
      const tenantId = tenant.id;
      const mkUser = (role: "OPERATOR" | "DRIVER" | "CUSTOMER", tag: string) =>
        raw.user.create({
          data: {
            email: `${tag}-${slug}@example.invalid`,
            username: `${tag}-${slug}`,
            role,
            tenantId,
          },
        });
      const op = await mkUser("OPERATOR", "op");
      const drvUser = await mkUser("DRIVER", "drv");
      const custUser = await mkUser("CUSTOMER", "cust");
      const driver = await raw.driver.create({
        data: { userId: drvUser.id, contactName: `B1106 driver ${label}`, tenantId } as any,
      });
      const customer = await raw.customer.create({
        data: {
          userId: custUser.id,
          businessName: `B1106 customer ${label}`,
          contactName: `B1106 contact ${label}`,
          tenantId,
        },
      });
      const product = await raw.product.create({
        data: {
          tenantId,
          name: `B1106 product ${label}`,
          sku: `B1106-${RUN}-${label}`,
          unit: "each",
          pricePerUnit: "10.00",
          currentStock: 100,
        },
      });
      const route = await raw.route.create({
        data: { name: `b1106-${RUN}-${label}`, tenantId } as any,
      });
      const routeStop = await raw.routeStop.create({
        data: { tenantId, routeId: route.id, stopNumber: 1, customerId: customer.id } as any,
      });
      const run = await raw.routeRun.create({
        data: {
          tenantId,
          routeId: route.id,
          scheduledDate: new Date("2026-11-05T00:00:00.000Z"),
          status: "IN_PROGRESS" as any,
          driverId: driver.id,
        },
      });
      const stop = await raw.routeRunStop.create({
        data: {
          tenantId,
          routeRunId: run.id,
          routeStopId: routeStop.id,
          stopNumber: 1,
          customerId: customer.id,
          status: "PENDING" as any,
        } as any,
      });
      return {
        tenantId,
        slug,
        opId: op.id,
        driverUserId: drvUser.id,
        customerId: customer.id,
        productId: product.id,
        runId: run.id,
        stopId: stop.id,
      };
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      ctx = new TenantContextService();
      prisma = new PrismaService(ctx);
      await prisma.$connect();
      a = await world("a");
      b = await world("b");
      const idempotency = new IdempotencyService();
      const numbering = new NumberingService(prisma);
      const ledger = new RegulatedLedgerService(prisma);
      const systemConfig = new SystemConfigService(
        prisma,
        new EncryptionService({ get: () => undefined } as any),
      );
      const creditNotes = Object.assign(Object.create(CreditNotesService.prototype), {
        prisma,
        gateway: { emitCreditNoteCreated: jest.fn() },
        ledger,
        commissionEngine: {},
        numbering,
        logger: new Logger(CreditNotesService.name),
      });
      inlineSvc = Object.assign(Object.create(InlineReturnsService.prototype), {
        prisma,
        gateway: { emitCreditNoteCreated: jest.fn() },
        ledger,
        creditNotes,
        numbering,
        addonService: { hasAddon: async () => true },
        quoteService: new InlineReturnsQuoteService(prisma, systemConfig),
        idempotency,
      });
      orders = Object.assign(Object.create(OrdersService.prototype), {
        prisma,
        gateway: { emitOrderCreated: jest.fn(), emitUrgentOrder: jest.fn() },
        systemConfig,
        entitlements: { hasFlag: async () => true },
        sellingRestrictions: { assertLinesSellable: async () => undefined },
        authGuard: { assertAuthorizedOrThrow: async () => undefined },
        promotionsService: { activeForCatalog: async () => [] },
        creditNotes,
        ledger,
        tenantCtx: ctx,
        logger: new Logger(OrdersService.name),
        inlineReturns: inlineSvc,
      });
      drivers = Object.assign(Object.create(DriversService.prototype), { prisma });
      messages = Object.assign(Object.create(MessagesService.prototype), { prisma });
    }, 120_000);

    afterAll(async () => {
      for (const tenantId of tenantIds) {
        // eslint-disable-next-line no-await-in-loop
        await (async () => {
          const ords = (
            await raw.order.findMany({ where: { tenantId }, select: { id: true } })
          ).map((o) => o.id);
          await raw.orderCreditNote.deleteMany({ where: { orderId: { in: ords } } });
          await raw.returnItem.deleteMany({ where: { return: { tenantId } } });
          await raw.return.deleteMany({ where: { tenantId } });
          await raw.creditNote.deleteMany({ where: { tenantId } });
          await raw.orderItem.deleteMany({ where: { orderId: { in: ords } } });
          await raw.order.deleteMany({ where: { tenantId } });
          await raw.message.deleteMany({ where: { tenantId } });
          await raw.driverLocation.deleteMany({ where: { driver: { tenantId } } });
          await raw.routeRunStop.deleteMany({ where: { tenantId } });
          await raw.routeRun.deleteMany({ where: { tenantId } });
          await raw.routeStop.deleteMany({ where: { tenantId } });
          await raw.route.deleteMany({ where: { tenantId } });
          await raw.driver.deleteMany({ where: { tenantId } });
          await raw.stockMovement.deleteMany({ where: { product: { tenantId } } });
          await raw.product.deleteMany({ where: { tenantId } });
          await raw.customer.deleteMany({ where: { tenantId } });
          await raw.systemConfig.deleteMany({ where: { tenantId } });
          await raw.user.deleteMany({ where: { tenantId } });
          await raw.tenant.delete({ where: { id: tenantId } });
        })().catch((e: unknown) => {
          // eslint-disable-next-line no-console
          console.error(`B1106 cleanup failed for ${tenantId}:`, e);
        });
      }
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    const asA = <T>(fn: () => Promise<T>) => ctx.run(a.tenantId, fn);
    const staffA = (): JwtPayload =>
      ({
        sub: a.opId,
        username: "operator",
        role: "OPERATOR",
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId: a.tenantId,
        tenantSlug: a.slug,
      }) as JwtPayload;

    describe("the helper's two new kinds", () => {
      it("run: own passes; tenant B's and a missing id are the same 404 'Run not found'", async () => {
        await asA(() => assertRefsInTenant(prisma, { routeRunIds: [a.runId] }));
        for (const id of [b.runId, randomUUID()]) {
          await expect(
            asA(() => assertRefsInTenant(prisma, { routeRunIds: [id] })),
          ).rejects.toThrow("Run not found");
        }
      });

      it("stop: own passes; tenant B's and a missing id are the same 404 'Stop not found'", async () => {
        await asA(() => assertRefsInTenant(prisma, { routeRunStopIds: [a.stopId] }));
        for (const id of [b.stopId, randomUUID()]) {
          await expect(
            asA(() => assertRefsInTenant(prisma, { routeRunStopIds: [id] })),
          ).rejects.toThrow("Stop not found");
        }
      });
    });

    describe("writer 1 - DriversService.recordLocation", () => {
      it("tenant B's runId is a 404 and writes no DriverLocation row; the caller's own run is stored", async () => {
        await expect(
          asA(() =>
            drivers.recordLocation(a.driverUserId, {
              lat: 1,
              lng: 2,
              recordedAt: "2026-11-05T00:00:00.000Z",
              runId: b.runId,
            } as never),
          ),
        ).rejects.toThrow("Run not found");
        expect(await raw.driverLocation.count({ where: { runId: b.runId } })).toBe(0);

        await asA(() =>
          drivers.recordLocation(a.driverUserId, {
            lat: 1,
            lng: 2,
            recordedAt: "2026-11-05T00:00:00.000Z",
            runId: a.runId,
          } as never),
        );
        expect(await raw.driverLocation.count({ where: { runId: a.runId } })).toBe(1);
      });
    });

    describe("writer 2 - MessagesService.create (staff path)", () => {
      it.each(["OPERATOR", "TENANT_ADMIN"])(
        "%s: tenant B's runId is a 404 and writes no Message row; the caller's own run is stored",
        async (role) => {
          await expect(
            asA(() => messages.create({ runId: b.runId, text: "hello" }, a.opId, role)),
          ).rejects.toThrow("Run not found");
          expect(await raw.message.count({ where: { runId: b.runId } })).toBe(0);

          await asA(() => messages.create({ runId: a.runId, text: "hello" }, a.opId, role));
          expect(await raw.message.count({ where: { runId: a.runId, senderRole: role } })).toBe(1);
        },
      );
    });

    describe("writer 4 - OrdersService.create (staff path)", () => {
      const create = (over: Record<string, unknown>) =>
        asA(() =>
          orders.create(
            {
              customerId: a.customerId,
              items: [{ productId: a.productId, qty: 1 }],
              ...over,
            },
            staffA(),
            { skipAutoMerge: true },
          ),
        );

      it("tenant B's routeRunId / routeRunStopId is a 404 and no order is written, in either tenant", async () => {
        await expect(create({ routeRunId: b.runId })).rejects.toThrow("Run not found");
        await expect(create({ routeRunStopId: b.stopId })).rejects.toThrow("Stop not found");
        expect(
          await raw.order.count({
            where: { routeRunId: b.runId },
          }),
        ).toBe(0);
        expect(await raw.order.count({ where: { routeRunStopId: b.stopId } })).toBe(0);
        expect(await raw.order.count({ where: { tenantId: a.tenantId } })).toBe(0);
      });

      it("the caller's own run and stop are linked as before", async () => {
        const o = (await create({ routeRunId: a.runId, routeRunStopId: a.stopId })) as {
          id: string;
        };
        const row = await raw.order.findUniqueOrThrow({ where: { id: o.id } });
        expect(row.routeRunId).toBe(a.runId);
        expect(row.routeRunStopId).toBe(a.stopId);
      });

      it("an inline return that names tenant B's stop is a 404 and writes no order, no Return and no credit note", async () => {
        await expect(
          create({
            inlineReturn: {
              items: [{ productId: a.productId, qty: 1 }],
              returnKey: `k-b1106-${RUN}`,
              routeRunStopId: b.stopId,
            },
          }),
        ).rejects.toThrow("Stop not found");
        expect(
          await raw.order.count({ where: { customerId: a.customerId, routeRunId: null } }),
        ).toBe(0);
        expect(await raw.return.count({ where: { routeRunStopId: b.stopId } })).toBe(0);
        expect(await raw.creditNote.count({ where: { tenantId: a.tenantId } })).toBe(0);
      });
    });

    describe("writer 7 - InlineReturnsService.capture (staff path)", () => {
      it("a standalone capture that names tenant B's stop is a 404 and writes no Return", async () => {
        const order = await raw.order.create({
          data: {
            tenantId: a.tenantId,
            customerId: a.customerId,
            orderNumber: `B1106-${RUN}-cap`,
            status: "DELIVERED" as any,
            total: 10,
          } as any,
        });
        await expect(
          asA(() =>
            inlineSvc.capture(
              {
                orderId: order.id,
                customerId: a.customerId,
                items: [{ productId: a.productId, qty: 1 }],
                returnKey: `k-b1106-cap-${RUN}`,
                routeRunStopId: b.stopId,
              },
              staffA(),
            ),
          ),
        ).rejects.toThrow(NotFoundException);
        expect(await raw.return.count({ where: { orderId: order.id } })).toBe(0);
        expect(await raw.return.count({ where: { routeRunStopId: b.stopId } })).toBe(0);
      });
    });
  },
);
