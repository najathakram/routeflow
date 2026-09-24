/**
 * B756 / SA-131 — DB-lane round-trip for findOneRun's legacy unlinked-orders fallback.
 *
 * WHY THE DB LANE: routes.service.spec.ts proves this against a MOCKED Prisma client — it
 * asserts on the `where`/`select` OBJECT the code builds, never that a real Postgres actually
 * applies it. That leaves real gaps a mock can't see: a `notIn` filter shadowed by another
 * `where` clause merged in later, RUN_STOP_INCLUDE's nested projections dropped by a schema/
 * relation mismatch, or Prisma's own tenant-scoping (`forTenant()`) failing to isolate a stray
 * cross-tenant row. This file drives the REAL `RoutesService.findOneRun()` through a NestJS
 * TestingModule wired with a REAL `PrismaService` (bound to the compose Postgres); every other
 * collaborator is trivially mocked since findOneRun's fallback path never calls them.
 *
 * SA-131 split this fallback into two branches by run status:
 * - OPEN run (not COMPLETED/CANCELLED): orders resolved by customerId, `notIn
 *   NON_ROUTABLE_ORDER_STATUSES` (DRAFT, DELIVERED, CANCELLED excluded).
 * - CLOSED run (COMPLETED/CANCELLED): orders resolved by DeliveryMutation evidence rows keyed
 *   to the stop (routeRunStopId), at ANY status — never the customer's live order history.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 *
 * SAFETY: every tenant this file creates is a throwaway `qa-b756-<run>-<n>` slug, approved by
 * `assertTestTenant` (`scripts/lib/test-tenants.cjs`); `afterAll` deletes exactly the rows this
 * run created, in FK order, never anyone else's.
 */

import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { RoutesService } from "./routes.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NotificationsService } from "../notifications/notifications.service";
import { MessagingService } from "../messaging/messaging.service";
import { InvoicesService } from "../invoices/invoices.service";
import { StorageService } from "../storage/storage.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);

describeDb("B756/SA-131 findOneRun legacy fallback — real Postgres round-trip", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let routesService: RoutesService;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    // Nothing env-dependent may run at collection time (db-lane.db.spec.ts's rule): the real
    // connection is built here, inside a hook, never at module top level.
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoutesService,
        { provide: PrismaService, useValue: prisma },
        // findOneRun's fallback path never touches any of these.
        { provide: RouteFlowGateway, useValue: {} },
        { provide: NotificationsService, useValue: {} },
        { provide: MessagingService, useValue: { notifyEvent: jest.fn() } },
        { provide: InvoicesService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: StorageService, useValue: {} },
        { provide: FeatureConfigService, useValue: {} },
      ],
    }).compile();

    routesService = module.get(RoutesService);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => {
        // Best-effort: a failed cleanup must never mask the test's own pass/fail result.
      });
    }
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.deliveryMutation.deleteMany({ where: { tenantId } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.routeRunStop.deleteMany({ where: { tenantId } });
    await prisma.routeStop.deleteMany({ where: { tenantId } });
    await prisma.routeRun.deleteMany({ where: { tenantId } });
    await prisma.route.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seedTenant(): Promise<{ id: string }> {
    const slug = assertTestTenant(
      `qa-b756-${RUN_SUFFIX}-${createdTenantIds.length + 1}`,
      "find-one-run-fallback.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `B756 ${slug}` } });
    createdTenantIds.push(tenant.id);
    return { id: tenant.id };
  }

  async function seedCustomer(
    tenantId: string,
    over: { isTaxExempt?: boolean } = {},
  ): Promise<{ id: string }> {
    const idBase = `${tenantId}-cust-${randomUUID().slice(0, 6)}`;
    const user = await prisma.user.create({
      data: { email: `${idBase}@example.invalid`, username: idBase, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: "B756 customer",
        contactName: "B756 contact",
        isTaxExempt: over.isTaxExempt ?? false,
        tenantId,
      },
    });
    return { id: customer.id };
  }

  /** A route + an OPEN (SCHEDULED/IN_PROGRESS) or CLOSED (COMPLETED/CANCELLED) run with one
   * legacy/seeded stop per given customer — no direct customer/address link (only routeStopId),
   * no linked orders. Returns the run and each stop's id, in customer order. */
  async function seedUnlinkedRun(
    tenantId: string,
    status: "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED",
    customerIds: string[],
  ): Promise<{ runId: string; stopIds: string[] }> {
    const route = await prisma.route.create({ data: { name: "B756 route", tenantId } });
    const run = await prisma.routeRun.create({
      data: {
        routeId: route.id,
        status,
        scheduledDate: new Date("2026-09-24T00:00:00.000Z"),
        tenantId,
      },
    });
    const stopIds: string[] = [];
    for (let i = 0; i < customerIds.length; i++) {
      const routeStop = await prisma.routeStop.create({
        data: { routeId: route.id, customerId: customerIds[i], stopNumber: i + 1, tenantId },
      });
      const runStop = await prisma.routeRunStop.create({
        data: {
          routeRunId: run.id,
          routeStopId: routeStop.id,
          stopNumber: i + 1,
          status: status === "COMPLETED" ? "COMPLETED" : "PENDING",
          tenantId,
        },
      });
      stopIds.push(runStop.id);
    }
    return { runId: run.id, stopIds };
  }

  async function seedOrder(
    tenantId: string,
    customerId: string,
    status:
      | "DRAFT"
      | "PENDING"
      | "CONFIRMED"
      | "OUT_FOR_DELIVERY"
      | "PARTIALLY_DELIVERED"
      | "DELIVERED"
      | "CANCELLED",
    over: { total?: number } = {},
  ): Promise<{ id: string; total: unknown }> {
    return prisma.order.create({
      data: {
        customerId,
        status,
        orderNumber: `B756-${status}-${randomUUID().slice(0, 6)}`,
        total: over.total ?? 0,
        tenantId,
      },
    });
  }

  it(
    "(a)+(b) an OPEN run's unlinked stop shows only the routable orders — PENDING and " +
      "PARTIALLY_DELIVERED, never DRAFT/DELIVERED/CANCELLED",
    async () => {
      const tenant = await seedTenant();
      const customer = await seedCustomer(tenant.id, { isTaxExempt: true });
      const draft = await seedOrder(tenant.id, customer.id, "DRAFT");
      const pending = await seedOrder(tenant.id, customer.id, "PENDING");
      const partiallyDelivered = await seedOrder(tenant.id, customer.id, "PARTIALLY_DELIVERED");
      const delivered = await seedOrder(tenant.id, customer.id, "DELIVERED");
      const cancelled = await seedOrder(tenant.id, customer.id, "CANCELLED");
      void draft;
      void delivered;
      void cancelled;
      const { runId } = await seedUnlinkedRun(tenant.id, "IN_PROGRESS", [customer.id]);

      const result: any = await tenantCtx.run(tenant.id, () => routesService.findOneRun(runId));

      expect(result.stops).toHaveLength(1);
      const stop = result.stops[0];

      // Exact set equality, not "contains": DRAFT/DELIVERED/CANCELLED must be ABSENT, not just
      // the routable two present alongside something extra.
      const orderIds = stop.orders.map((o: any) => o.id).sort();
      expect(orderIds).toEqual([partiallyDelivered.id, pending.id].sort());

      // The isTaxExempt fix (round 5/#1272): resolved through routeStop.customer.
      expect(stop.customer?.isTaxExempt).toBe(true);

      // Money fields + customerId (B305 round 5) are projected, not just id/orderNumber/status.
      const pendingRow = stop.orders.find((o: any) => o.id === pending.id);
      expect(pendingRow).toEqual(
        expect.objectContaining({
          customerId: customer.id,
          subtotal: expect.anything(),
          tax: expect.anything(),
          total: expect.anything(),
          discountAmount: expect.anything(),
          shippingFee: expect.anything(),
        }),
      );
    },
    30_000,
  );

  it(
    "(e) the door quote: an OPEN run's fallback result sums to exactly the PENDING order's own " +
      "total — stopAmountDue (mobile run-money.ts:234) sums stop.orders UNFILTERED, so it is " +
      "this API's own status filter, not any client-side filtering, that keeps DRAFT/DELIVERED/" +
      "CANCELLED out of the door quote",
    async () => {
      const tenant = await seedTenant();
      const customer = await seedCustomer(tenant.id);
      await seedOrder(tenant.id, customer.id, "DRAFT", { total: 40 });
      const pending = await seedOrder(tenant.id, customer.id, "PENDING", { total: 25 });
      await seedOrder(tenant.id, customer.id, "DELIVERED", { total: 60 });
      await seedOrder(tenant.id, customer.id, "CANCELLED", { total: 15 });
      const { runId } = await seedUnlinkedRun(tenant.id, "IN_PROGRESS", [customer.id]);

      const result: any = await tenantCtx.run(tenant.id, () => routesService.findOneRun(runId));

      const stop = result.stops[0];
      // This id-set check is what actually pins the fix: the API's own list is exactly
      // [pending], so DRAFT/DELIVERED/CANCELLED can never reach any downstream summation.
      expect(stop.orders.map((o: any) => o.id)).toEqual([pending.id]);
      // Mirrors stopAmountDue's own unfiltered sum over stop.orders — illustrative, not a
      // second oracle: with the id-set already exactly [pending], this can only ever equal
      // the PENDING order's own total.
      const naiveSum = stop.orders.reduce((sum: number, o: any) => sum + Number(o.total), 0);
      expect(naiveSum).toEqual(Number(pending.total));
    },
    30_000,
  );

  it("cross-tenant isolation: another tenant's stray order for the same customerId never leaks in", async () => {
    const tenant = await seedTenant();
    const otherTenant = await seedTenant();
    const customer = await seedCustomer(tenant.id);
    const ownOrder = await seedOrder(tenant.id, customer.id, "PENDING");
    // A mis-tenanted row: tenantId=otherTenant, but customerId points at tenant's own
    // customer — proves forTenant()'s scoping, not just an accidental id mismatch.
    await prisma.order.create({
      data: {
        customerId: customer.id,
        status: "PENDING",
        orderNumber: "B756-CROSS-TENANT",
        tenantId: otherTenant.id,
      },
    });
    const { runId } = await seedUnlinkedRun(tenant.id, "IN_PROGRESS", [customer.id]);

    const result: any = await tenantCtx.run(tenant.id, () => routesService.findOneRun(runId));

    const orderIds = result.stops[0].orders.map((o: any) => o.id);
    expect(orderIds).toEqual([ownOrder.id]);
  }, 30_000);

  it("(c) a CLOSED run's stop shows exactly the orders with a DeliveryMutation row for that stop, whatever their status", async () => {
    const tenant = await seedTenant();
    const customer = await seedCustomer(tenant.id);
    const delivered = await seedOrder(tenant.id, customer.id, "DELIVERED");
    const cancelled = await seedOrder(tenant.id, customer.id, "CANCELLED");
    const noEvidence = await seedOrder(tenant.id, customer.id, "PENDING");
    void noEvidence;
    const { runId, stopIds } = await seedUnlinkedRun(tenant.id, "COMPLETED", [customer.id]);

    await prisma.deliveryMutation.create({
      data: {
        orderId: delivered.id,
        routeRunStopId: stopIds[0],
        type: "DELIVERED",
        quantityDelivered: 1,
        tenantId: tenant.id,
      },
    });
    await prisma.deliveryMutation.create({
      data: {
        orderId: cancelled.id,
        routeRunStopId: stopIds[0],
        type: "REFUSED",
        quantityDelivered: 0,
        tenantId: tenant.id,
      },
    });

    const result: any = await tenantCtx.run(tenant.id, () => routesService.findOneRun(runId));

    const orderIds = result.stops[0].orders.map((o: any) => o.id).sort();
    // Exact set equality: the evidence rows, and ONLY the evidence rows — never the
    // customer's un-evidenced PENDING order, regardless of status.
    expect(orderIds).toEqual([cancelled.id, delivered.id].sort());

    // Money fields + customerId (B305 round 5) are projected on the closed branch too, not
    // just id/orderNumber/status.
    const deliveredRow = result.stops[0].orders.find((o: any) => o.id === delivered.id);
    expect(deliveredRow).toEqual(
      expect.objectContaining({
        customerId: customer.id,
        subtotal: expect.anything(),
        tax: expect.anything(),
        total: expect.anything(),
        discountAmount: expect.anything(),
        shippingFee: expect.anything(),
      }),
    );
  }, 30_000);

  it("the closed-run branch fires for CANCELLED runs too, not only COMPLETED — same DeliveryMutation evidence lookup", async () => {
    const tenant = await seedTenant();
    const customer = await seedCustomer(tenant.id);
    const delivered = await seedOrder(tenant.id, customer.id, "DELIVERED");
    const noEvidence = await seedOrder(tenant.id, customer.id, "PENDING");
    void noEvidence;
    const { runId, stopIds } = await seedUnlinkedRun(tenant.id, "CANCELLED", [customer.id]);

    await prisma.deliveryMutation.create({
      data: {
        orderId: delivered.id,
        routeRunStopId: stopIds[0],
        type: "DELIVERED",
        quantityDelivered: 1,
        tenantId: tenant.id,
      },
    });

    const result: any = await tenantCtx.run(tenant.id, () => routesService.findOneRun(runId));

    expect(result.stops[0].orders.map((o: any) => o.id)).toEqual([delivered.id]);
  }, 30_000);

  it("closed-branch cross-tenant isolation: a mis-tenanted DeliveryMutation row on this tenant's own stop id is ignored", async () => {
    const tenant = await seedTenant();
    const otherTenant = await seedTenant();
    const customer = await seedCustomer(tenant.id);
    const delivered = await seedOrder(tenant.id, customer.id, "DELIVERED");
    // No evidence of its own — this order must stay un-surfaced unless the mis-tenanted row
    // below wrongly reaches it.
    const noEvidence = await seedOrder(tenant.id, customer.id, "PENDING");
    const { runId, stopIds } = await seedUnlinkedRun(tenant.id, "COMPLETED", [customer.id]);

    // A real evidence row for tenant's own order.
    await prisma.deliveryMutation.create({
      data: {
        orderId: delivered.id,
        routeRunStopId: stopIds[0],
        type: "DELIVERED",
        quantityDelivered: 1,
        tenantId: tenant.id,
      },
    });
    // A mis-tenanted row: tenantId=otherTenant, but routeRunStopId points at tenant's own stop
    // AND orderId points at tenant's own (otherwise un-evidenced) order. This is deliberately
    // NOT a stray order some other tenant could never resolve on its own — if forTenant() were
    // ever dropped from this lookup, this row alone would wrongly surface `noEvidence`, since
    // its orderId is perfectly resolvable on THIS tenant. Only forTenant()'s tenantId scope on
    // the DeliveryMutation query itself keeps it out.
    await prisma.deliveryMutation.create({
      data: {
        orderId: noEvidence.id,
        routeRunStopId: stopIds[0],
        type: "DELIVERED",
        quantityDelivered: 1,
        tenantId: otherTenant.id,
      },
    });

    const result: any = await tenantCtx.run(tenant.id, () => routesService.findOneRun(runId));

    expect(result.stops[0].orders.map((o: any) => o.id)).toEqual([delivered.id]);
  }, 30_000);

  it(
    "SA-131a: an ADD_ON row alone is never evidence (no order surfaces); a REFUSED row with " +
      "quantityDelivered 0 surfaces its order; DELIVERED still surfaces",
    async () => {
      const tenant = await seedTenant();
      const customer = await seedCustomer(tenant.id);
      const addOnOnly = await seedOrder(tenant.id, customer.id, "PENDING");
      const refused = await seedOrder(tenant.id, customer.id, "CANCELLED");
      const delivered = await seedOrder(tenant.id, customer.id, "DELIVERED");
      const { runId, stopIds } = await seedUnlinkedRun(tenant.id, "COMPLETED", [customer.id]);

      // An at-stop change-request addition — never proof the order's own delivery resolved.
      await prisma.deliveryMutation.create({
        data: {
          orderId: addOnOnly.id,
          routeRunStopId: stopIds[0],
          type: "ADD_ON",
          quantityDelivered: 1,
          tenantId: tenant.id,
        },
      });
      // A real refusal (quantityDelivered 0, not null) — DOES count.
      await prisma.deliveryMutation.create({
        data: {
          orderId: refused.id,
          routeRunStopId: stopIds[0],
          type: "REFUSED",
          quantityDelivered: 0,
          tenantId: tenant.id,
        },
      });
      await prisma.deliveryMutation.create({
        data: {
          orderId: delivered.id,
          routeRunStopId: stopIds[0],
          type: "DELIVERED",
          quantityDelivered: 1,
          tenantId: tenant.id,
        },
      });

      const result: any = await tenantCtx.run(tenant.id, () => routesService.findOneRun(runId));

      const orderIds = result.stops[0].orders.map((o: any) => o.id).sort();
      expect(orderIds).toEqual([delivered.id, refused.id].sort());
    },
    30_000,
  );

  it("SA-131a: a REFUSED-for-remove row with quantityDelivered null is never evidence", async () => {
    const tenant = await seedTenant();
    const customer = await seedCustomer(tenant.id);
    const removedViaChangeRequest = await seedOrder(tenant.id, customer.id, "CANCELLED");
    const { runId, stopIds } = await seedUnlinkedRun(tenant.id, "COMPLETED", [customer.id]);

    await prisma.deliveryMutation.create({
      data: {
        orderId: removedViaChangeRequest.id,
        routeRunStopId: stopIds[0],
        type: "REFUSED",
        quantityDelivered: null,
        tenantId: tenant.id,
      },
    });

    const result: any = await tenantCtx.run(tenant.id, () => routesService.findOneRun(runId));

    expect(result.stops[0].orders).toEqual([]);
  }, 30_000);

  it("(d) a CLOSED run's stop with no recorded DeliveryMutation evidence shows no orders", async () => {
    const tenant = await seedTenant();
    const customer = await seedCustomer(tenant.id);
    await seedOrder(tenant.id, customer.id, "PENDING");
    await seedOrder(tenant.id, customer.id, "DELIVERED");
    const { runId } = await seedUnlinkedRun(tenant.id, "COMPLETED", [customer.id]);

    const result: any = await tenantCtx.run(tenant.id, () => routesService.findOneRun(runId));

    expect(result.stops[0].orders).toEqual([]);
  }, 30_000);

  it(
    "the linked-orders path is untouched: a run WITH a directly-linked order never reaches the " +
      "fallback and still shows its DELIVERED linked order",
    async () => {
      const tenant = await seedTenant();
      const customer = await seedCustomer(tenant.id);
      const route = await prisma.route.create({
        data: { name: "B756 linked route", tenantId: tenant.id },
      });
      const run = await prisma.routeRun.create({
        data: {
          routeId: route.id,
          status: "IN_PROGRESS",
          scheduledDate: new Date("2026-09-24T00:00:00.000Z"),
          tenantId: tenant.id,
        },
      });
      const routeStop = await prisma.routeStop.create({
        data: { routeId: route.id, customerId: customer.id, stopNumber: 1, tenantId: tenant.id },
      });
      const runStop = await prisma.routeRunStop.create({
        data: {
          routeRunId: run.id,
          routeStopId: routeStop.id,
          stopNumber: 1,
          status: "PENDING",
          customerId: customer.id,
          tenantId: tenant.id,
        },
      });
      // Directly linked to this run/stop — the MAIN query (not the fallback) reads this, and it
      // carries no status filter, so DELIVERED must still show.
      const linkedDelivered = await prisma.order.create({
        data: {
          customerId: customer.id,
          routeRunId: run.id,
          routeRunStopId: runStop.id,
          status: "DELIVERED",
          orderNumber: "B756-LINKED-DELIVERED",
          tenantId: tenant.id,
        },
      });
      // A second, UNLINKED PENDING order for the same customer — if the fallback wrongly fired
      // anyway, this would appear too; it must not, since anyLinked is true for this run.
      await seedOrder(tenant.id, customer.id, "PENDING");

      const result: any = await tenantCtx.run(tenant.id, () => routesService.findOneRun(run.id));

      const orderIds = result.stops[0].orders.map((o: any) => o.id);
      expect(orderIds).toEqual([linkedDelivered.id]);
    },
    30_000,
  );
});
