/**
 * Row 510 — real-Postgres proof of the AT-DOOR change request that would sell a restricted product, THROUGH
 * ChangeRequestsService -> OrdersService.approveChangeRequestAtStop with the REAL SellingRestrictionsService:
 *
 *   driver      the driver's self-resolve is the hard block "Ask the office to approve this sale", carrying the per-rule
 *               lines (the legal copy) keyed `cr:<id>`; the CR STAYS PENDING (a declined CR cannot be approved), nothing is
 *               stamped and no audit row is written.
 *   office      approving that same PENDING CR with no acknowledgement is 409 RESTRICTION_WARNING (same lineKey); with the
 *               hash and a reason it is APPROVED, the line is stamped by the OFFICE user, and exactly one audit row names it.
 *   no loop     a stale hash is a 409 again with the fresh list and writes nothing.
 *
 * Collected only by jest.db.config.js (`RUN_DB_SPECS=local npx jest -c jest.db.config.js --runInBand <this file>`).
 * One throwaway `qa-r510-<run>` tenant approved by `assertTestTenant`, deleted in afterAll.
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({
    createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
    findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
    reconcileOrderDraftInvoice: jest.fn().mockResolvedValue(null),
    resyncOrderInvoicesForEdit: jest.fn().mockResolvedValue([]),
    followPartialPrices: jest.fn().mockResolvedValue({ issuedPartialsUnchanged: [] }),
    projectEditedInvoiceTotals: jest.fn().mockResolvedValue([]),
    revertLinkedInvoicesForOrderEdit: jest.fn().mockResolvedValue([]),
    findOpenOrderDraft: jest.fn().mockResolvedValue(null),
    createInvoiceFromOrder: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
    voidInvoiceInTx: jest.fn().mockResolvedValue({ id: "inv-1", status: "VOID" }),
  })),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({
    sendToCustomer: jest.fn().mockResolvedValue(undefined),
    sendToDriver: jest.fn().mockResolvedValue(undefined),
    sendToUser: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { ChangeRequestsService } from "./change-requests.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import {
  DRIVER_RESTRICTION_BLOCK_MESSAGE,
  SUPPORT_SESSION_RESTRICTION_BLOCK_MESSAGE,
} from "../selling-restrictions/override-constants";
import {
  purgeOverrideWorld,
  seedOverrideWorld,
  setStoreState,
  staffPayload,
  type OverrideWorld,
} from "../../test/restriction-override-fixture";
import { buildOverrideModule } from "../../test/restriction-override-module";

const RUN = randomUUID().slice(0, 8);
const REASON = "Licensed buyer, paperwork on file";

describeDb(
  "row 510: an at-door change request of a restricted product — driver blocked, office warned and stamps — real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let crs: ChangeRequestsService;
    let dbPrisma: PrismaService;
    let tenantCtx: TenantContextService;
    let w: OverrideWorld;
    let driverRowId: string;
    const url = () => requireLocalDatabaseUrl();

    const as = <T>(fn: () => Promise<T>) => tenantCtx.run(w.tenantId, fn);
    const staff = (role: "OPERATOR" | "TENANT_ADMIN" | "DRIVER" | "SUPER_ADMIN" = "OPERATOR") =>
      staffPayload(w, role);
    const errOf = async (p: Promise<unknown>): Promise<any> => {
      try {
        await p;
      } catch (e) {
        return e;
      }
      throw new Error("expected a rejection");
    };
    const bodyOf = (e: any) => e.getResponse() as any;
    const ackFrom = (e: any, reason = REASON) => ({
      warningHash: bodyOf(e).warningHash as string,
      restrictionOverrides: (bodyOf(e).lines as Array<{ lineKey: string }>).map((l) => ({
        lineKey: l.lineKey,
        reason,
      })),
    });
    const lineRows = (orderId: string) =>
      raw.orderItem.findMany({ where: { orderId }, orderBy: [{ createdAt: "asc" }] });
    const audits = (orderId: string) =>
      raw.auditLog.findMany({
        where: {
          tenantId: w.tenantId,
          action: "selling_restriction.overridden",
          meta: { path: ["documentId"], equals: orderId },
        },
      });
    const crRow = (id: string) => raw.changeRequest.findUniqueOrThrow({ where: { id } });

    /** An order on a started run (so a change request is allowed) with one clean line, plus the driver's run/stop. */
    async function seedDoorOrder() {
      const route = await raw.route.create({
        data: { name: `r-${RUN}-${randomUUID().slice(0, 4)}`, tenantId: w.tenantId } as any,
      });
      const routeStop = await raw.routeStop.create({
        data: {
          tenantId: w.tenantId,
          routeId: route.id,
          stopNumber: 1,
          customerId: w.caCustomerId,
        } as any,
      });
      const run = await raw.routeRun.create({
        data: {
          tenantId: w.tenantId,
          routeId: route.id,
          scheduledDate: new Date("2026-10-14T00:00:00.000Z"),
          status: "IN_PROGRESS" as any,
          driverId: driverRowId,
        },
      });
      const stop = await raw.routeRunStop.create({
        data: {
          tenantId: w.tenantId,
          routeRunId: run.id,
          routeStopId: routeStop.id,
          stopNumber: 1,
          status: "PENDING" as any,
        } as any,
      });
      const order = await raw.order.create({
        data: {
          tenantId: w.tenantId,
          customerId: w.caCustomerId,
          status: "OUT_FOR_DELIVERY" as never,
          fulfillPath: "ROUTE" as never,
          source: "APP",
          subtotal: "20",
          total: "20",
          routeRunId: run.id,
          routeRunStopId: stop.id,
          lineItems: {
            create: [
              {
                tenantId: w.tenantId,
                productId: w.clean,
                qty: "2",
                unitPrice: "10.00",
                subtotal: "20",
                status: "PENDING" as never,
                position: 0,
              },
            ],
          },
        },
      });
      return order.id;
    }
    /** The driver files the change request (what the at-door screen's `create` does before it self-resolves). */
    const fileAddBanned = (orderId: string, qty = 3) =>
      as(() =>
        crs.create(
          orderId,
          { type: "ADD_ITEM", productId: w.banned, qty } as never,
          staff("DRIVER"),
        ),
      );
    const resolve = (orderId: string, crId: string, body: object, user = staff()) =>
      as(() => crs.resolve(orderId, crId, body as never, user));

    beforeAll(async () => {
      pool = new Pool({ connectionString: url() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      dbPrisma = new PrismaService(tenantCtx);
      await dbPrisma.$connect();
      const module = await buildOverrideModule(tenantCtx, dbPrisma, [ChangeRequestsService]);
      crs = module.get(ChangeRequestsService);
      w = await seedOverrideWorld(raw, RUN, "restriction-override.change-request.db.spec.ts");
      await setStoreState(raw, w.tenantId, null);
      driverRowId = (
        await raw.driver.create({ data: { userId: w.driverId, tenantId: w.tenantId } as any })
      ).id;
    }, 120_000);

    afterAll(async () => {
      if (w?.tenantId) await purgeOverrideWorld(pool, w.tenantId);
      await dbPrisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    it("the DRIVER's self-resolve is the hard block with the legal lines keyed cr:<id>; the CR stays PENDING, nothing stamped, no audit", async () => {
      const orderId = await seedDoorOrder();
      const cr = await fileAddBanned(orderId);
      const e = await errOf(
        resolve(orderId, cr.id, { action: "APPROVE_AT_STOP" }, staff("DRIVER")),
      );
      expect(e.getStatus()).toBe(409);
      expect(bodyOf(e)).toMatchObject({
        code: "SELLING_RESTRICTED",
        message: DRIVER_RESTRICTION_BLOCK_MESSAGE,
        lines: [
          {
            lineKey: `cr:${cr.id}`,
            productId: w.banned,
            outcome: "BLOCK",
            rules: [
              {
                id: w.ruleId,
                states: ["CA"],
                legal: true,
                reasonText: "This product is banned in CA by law.",
              },
            ],
          },
        ],
      });
      expect(bodyOf(e).warningHash).toBeUndefined(); // a driver has no override to acknowledge
      expect((await crRow(cr.id)).status).toBe("PENDING"); // NOT declined: the office can still approve it
      expect(await lineRows(orderId)).toHaveLength(1); // the restricted line was never added
      expect(await audits(orderId)).toHaveLength(0);
    });

    it("a driver holding a valid acknowledgement is still blocked (the ack is never honoured for a driver)", async () => {
      const orderId = await seedDoorOrder();
      const cr = await fileAddBanned(orderId);
      const warned = await errOf(resolve(orderId, cr.id, { action: "APPROVE_AT_STOP" }));
      const e = await errOf(
        resolve(orderId, cr.id, { action: "APPROVE_AT_STOP", ...ackFrom(warned) }, staff("DRIVER")),
      );
      expect(bodyOf(e)).toMatchObject({
        code: "SELLING_RESTRICTED",
        message: DRIVER_RESTRICTION_BLOCK_MESSAGE,
      });
      expect((await crRow(cr.id)).status).toBe("PENDING");
      expect(await audits(orderId)).toHaveLength(0);
    });

    it("the office approving that PENDING CR with no acknowledgement is 409 RESTRICTION_WARNING; nothing is written", async () => {
      const orderId = await seedDoorOrder();
      const cr = await fileAddBanned(orderId);
      await errOf(resolve(orderId, cr.id, { action: "APPROVE_AT_STOP" }, staff("DRIVER")));
      const e = await errOf(resolve(orderId, cr.id, { action: "APPROVE_AT_STOP" }));
      expect(e.getStatus()).toBe(409);
      expect(bodyOf(e)).toMatchObject({
        code: "RESTRICTION_WARNING",
        warningHash: expect.stringMatching(/^rw1:/),
        lines: [{ lineKey: `cr:${cr.id}`, productId: w.banned, outcome: "BLOCK" }],
      });
      expect((await crRow(cr.id)).status).toBe("PENDING");
      expect(await lineRows(orderId)).toHaveLength(1);
      expect(await audits(orderId)).toHaveLength(0);
    });

    it("with the hash and a reason the office approves it: stamped by the OFFICE user, ONE audit row, the driver's request merged", async () => {
      const orderId = await seedDoorOrder();
      const cr = await fileAddBanned(orderId, 3);
      await errOf(resolve(orderId, cr.id, { action: "APPROVE_AT_STOP" }, staff("DRIVER")));
      const warned = await errOf(resolve(orderId, cr.id, { action: "APPROVE_AT_STOP" }));
      await resolve(orderId, cr.id, { action: "APPROVE_AT_STOP", ...ackFrom(warned) });

      const done = await crRow(cr.id);
      expect(done).toMatchObject({
        status: "APPROVED",
        resolution: "MERGED_AT_STOP",
        resolvedById: w.operatorId,
        resolvedByRole: "OPERATOR",
      });
      const rows = await lineRows(orderId);
      const banned = rows.find((r) => r.productId === w.banned)!;
      expect(Number(banned.qty)).toBe(3);
      expect(banned).toMatchObject({
        restrictionOverrideReason: REASON,
        restrictionOverrideBy: w.operatorId,
        restrictionOverrideRuleIds: [`${w.ruleId}:CA`],
      });
      expect(banned.restrictionOverrideAt).toBeInstanceOf(Date);
      const clean = rows.find((r) => r.productId === w.clean)!;
      expect(clean.restrictionOverrideAt).toBeNull();

      const a = await audits(orderId);
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({
        userId: w.operatorId, // the office, never the driver who filed it
        entityType: "OrderItem",
        entityId: banned.id,
        meta: expect.objectContaining({
          documentType: "ORDER",
          documentId: orderId,
          productId: w.banned,
          ruleIds: [`${w.ruleId}:CA`],
          reason: REASON,
          lineKey: `cr:${cr.id}`,
          basis: "CUSTOMER",
        }),
      });
    });

    it("a support session can't approve it: the 'Ask the account admin' block, the CR stays PENDING, nothing stamped", async () => {
      const orderId = await seedDoorOrder();
      const cr = await fileAddBanned(orderId);
      const warned = await errOf(resolve(orderId, cr.id, { action: "APPROVE_AT_STOP" }));
      const session = { ...staff("TENANT_ADMIN"), impersonatedBy: randomUUID() };
      const e = await errOf(
        resolve(
          orderId,
          cr.id,
          { action: "APPROVE_AT_STOP", ...ackFrom(warned) },
          session as never,
        ),
      );
      expect(bodyOf(e)).toMatchObject({
        code: "SELLING_RESTRICTED",
        message: SUPPORT_SESSION_RESTRICTION_BLOCK_MESSAGE,
        lines: [{ lineKey: `cr:${cr.id}`, productId: w.banned }],
      });
      expect((await crRow(cr.id)).status).toBe("PENDING");
      expect(await lineRows(orderId)).toHaveLength(1);
      expect(await audits(orderId)).toHaveLength(0);
    });

    it("a TENANT_ADMIN may approve it the same way", async () => {
      const orderId = await seedDoorOrder();
      const cr = await fileAddBanned(orderId);
      const warned = await errOf(
        resolve(orderId, cr.id, { action: "APPROVE_AT_STOP" }, staff("TENANT_ADMIN")),
      );
      await resolve(
        orderId,
        cr.id,
        { action: "APPROVE_AT_STOP", ...ackFrom(warned) },
        staff("TENANT_ADMIN"),
      );
      const banned = (await lineRows(orderId)).find((r) => r.productId === w.banned)!;
      expect(banned.restrictionOverrideBy).toBe(w.adminId);
    });

    it("a stale hash is 409 RESTRICTION_WARNING again with the fresh list, and the CR stays PENDING", async () => {
      const orderId = await seedDoorOrder();
      const cr = await fileAddBanned(orderId);
      const warned = await errOf(resolve(orderId, cr.id, { action: "APPROVE_AT_STOP" }));
      const stale = await errOf(
        resolve(orderId, cr.id, {
          action: "APPROVE_AT_STOP",
          ...ackFrom(warned),
          warningHash: "rw1:stale",
        }),
      );
      expect(bodyOf(stale).code).toBe("RESTRICTION_WARNING");
      expect(bodyOf(stale).warningHash).toBe(bodyOf(warned).warningHash);
      expect((await crRow(cr.id)).status).toBe("PENDING");
      expect(await audits(orderId)).toHaveLength(0);
    });

    it("a DECLINED request can no longer be approved (why the driver's block must not decline it)", async () => {
      const orderId = await seedDoorOrder();
      const cr = await fileAddBanned(orderId);
      await resolve(
        orderId,
        cr.id,
        { action: "DECLINE", reason: "Restricted item" },
        staff("DRIVER"),
      );
      const e = await errOf(resolve(orderId, cr.id, { action: "APPROVE_AT_STOP" }));
      expect(bodyOf(e).code).toBe("CHANGE_REQUEST_ALREADY_RESOLVED");
    });
  },
);
