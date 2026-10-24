/**
 * Row 510 — real-Postgres pins for two lock-time guarantees of the staff restriction override:
 *
 *   fold      a staff create that FOLDS into the customer's open PENDING order (OrdersController.create -> the merge
 *             branch -> updateOrderItems) carries the acknowledgement through: the first call is a 409 RESTRICTION_WARNING
 *             that writes nothing, the resubmit with the hash and a reason folds the line in and stamps it, with one
 *             audit row, and no second order.
 *   recheck   the fulfil-path switch and reopen ALWAYS re-check under the Order lock, even when the read before the lock
 *             was clean. A banned line that lands between that read and the lock (the lock's holder inserts it) is a
 *             product the judgement never saw: 409 ORDER_CHANGED_DURING_EDIT, nothing written.
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
import { Client, Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";
import { OrderBatchShipService } from "./order-batch-ship";
import { PackingSlipService } from "./packing-slip.service";
import { ChangeRequestsService } from "./change-requests.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
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
  "row 510: the create-merge fold carries the ack, and reopen / the path switch always re-check under the lock — real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let svc: OrdersService;
    let controller: OrdersController;
    let dbPrisma: PrismaService;
    let tenantCtx: TenantContextService;
    let w: OverrideWorld;
    const url = () => requireLocalDatabaseUrl();

    const as = <T>(fn: () => Promise<T>) => tenantCtx.run(w.tenantId, fn);
    const staff = () => staffPayload(w, "OPERATOR");
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
      raw.orderItem.findMany({ where: { orderId }, orderBy: [{ position: "asc" }] });
    const audits = (orderId: string) =>
      raw.auditLog.findMany({
        where: {
          tenantId: w.tenantId,
          action: "selling_restriction.overridden",
          meta: { path: ["documentId"], equals: orderId },
        },
      });
    const statusOf = async (orderId: string) =>
      (await raw.order.findUniqueOrThrow({ where: { id: orderId } })).status;
    const pathOf = async (orderId: string) =>
      (await raw.order.findUniqueOrThrow({ where: { id: orderId } })).fulfillPath;

    /** An order written straight to the table, one clean (or given) line. */
    async function seedOrder(
      customerId: string,
      productIds: string[],
      over: { status?: string; lineStatus?: string; fulfillPath?: string } = {},
    ) {
      const order = await raw.order.create({
        data: {
          tenantId: w.tenantId,
          customerId,
          status: (over.status ?? "PENDING") as never,
          fulfillPath: (over.fulfillPath ?? "ROUTE") as never,
          source: "APP",
          subtotal: "0",
          total: "0",
          lineItems: {
            create: productIds.map((productId, i) => ({
              tenantId: w.tenantId,
              productId,
              qty: "2",
              unitPrice: "10.00",
              subtotal: "20",
              status: (over.lineStatus ?? "PENDING") as never,
              position: i,
            })),
          },
        },
      });
      return order.id;
    }

    /**
     * Hold the Order row `FOR UPDATE` on a second connection and INSERT a banned line while holding it (the insert's FK
     * check needs the holder's own lock), run `action` (which must be blocked behind the holder), then commit. Whatever
     * the blocked write read BEFORE it got the lock is stale: it never saw that line.
     */
    async function withBannedLineInsertedUnderLock<T>(orderId: string, action: () => Promise<T>) {
      const holder = new Client({ connectionString: url() });
      await holder.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(`SELECT id FROM "Order" WHERE id = $1 FOR UPDATE`, [orderId]);
        await holder.query(
          `INSERT INTO "OrderItem" (id, "orderId", "tenantId", "productId", qty, "unitPrice", subtotal, status, position, "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, 1, 10, 10, 'PENDING', 9, now(), now())`,
          [randomUUID(), orderId, w.tenantId, w.banned],
        );
        let settled = false;
        const pending = action().then(
          (v) => ({ ok: true as const, v }),
          (e) => ({ ok: false as const, e }),
        );
        void pending.then(() => (settled = true));
        await new Promise((r) => setTimeout(r, 600));
        const blocked = !settled;
        await holder.query("COMMIT");
        return { blocked, result: await pending };
      } finally {
        await holder.end().catch(() => undefined);
      }
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: url() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      dbPrisma = new PrismaService(tenantCtx);
      await dbPrisma.$connect();
      const module = await buildOverrideModule(tenantCtx, dbPrisma, [
        { provide: ChangeRequestsService, useValue: {} },
        { provide: OrderBatchShipService, useValue: {} },
        { provide: PackingSlipService, useValue: {} },
        OrdersController,
      ]);
      svc = module.get(OrdersService);
      controller = module.get(OrdersController);
      w = await seedOverrideWorld(raw, RUN, "restriction-override.recheck-and-fold.db.spec.ts");
      await setStoreState(raw, w.tenantId, null);
    }, 120_000);

    afterAll(async () => {
      if (w?.tenantId) await purgeOverrideWorld(pool, w.tenantId);
      await dbPrisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    describe("create-merge fold", () => {
      it("a create that folds into the customer's open PENDING order warns first (nothing written), then folds and stamps with the ack", async () => {
        const open = await seedOrder(w.caCustomerId, [w.clean]);
        const orders = () =>
          raw.order.count({ where: { tenantId: w.tenantId, customerId: w.caCustomerId } });
        const ordersBefore = await orders();
        const dto = {
          customerId: w.caCustomerId,
          items: [{ productId: w.banned, qty: 1 }],
          mergeChoice: "merge",
        };
        const create = (body: object) => as(() => controller.create(body as never, staff()));

        const warned = await errOf(create(dto));
        expect(warned.getStatus()).toBe(409);
        expect(bodyOf(warned).code).toBe("RESTRICTION_WARNING");
        expect(bodyOf(warned).lines[0]).toMatchObject({ productId: w.banned, outcome: "BLOCK" });
        expect(await lineRows(open)).toHaveLength(1); // the warning wrote nothing
        expect(await audits(open)).toHaveLength(0);

        await create({ ...dto, ...ackFrom(warned) });
        const rows = await lineRows(open);
        expect(rows.map((r) => r.productId).sort()).toEqual([w.banned, w.clean].sort());
        const banned = rows.find((r) => r.productId === w.banned)!;
        expect(banned).toMatchObject({
          restrictionOverrideReason: REASON,
          restrictionOverrideBy: w.operatorId,
          restrictionOverrideRuleIds: [`${w.ruleId}:CA`],
        });
        expect(rows.find((r) => r.productId === w.clean)!.restrictionOverrideAt).toBeNull();
        expect(await audits(open)).toHaveLength(1);
        // folded, not created: no second order
        expect(await orders()).toBe(ordersBefore);
      });
    });

    describe("lock-time re-check on a clean pre-lock read", () => {
      it("the fulfil-path switch: a banned line added before the lock is a product the judgement never saw -> 409 ORDER_CHANGED_DURING_EDIT, the path is unchanged", async () => {
        await setStoreState(raw, w.tenantId, "TX");
        try {
          const orderId = await seedOrder(w.txCustomerId, [w.clean]);
          const { blocked, result } = await withBannedLineInsertedUnderLock(orderId, () =>
            as(() => svc.updateFulfillPath(orderId, { fulfillPath: "SHIP" } as never, staff())),
          );
          expect(blocked).toBe(true); // it waited for the Order lock instead of writing past it
          expect(result.ok).toBe(false);
          expect(bodyOf((result as { e: unknown }).e).code).toBe("ORDER_CHANGED_DURING_EDIT");
          expect(await pathOf(orderId)).toBe("ROUTE");
        } finally {
          await setStoreState(raw, w.tenantId, null);
        }
      }, 60_000);

      it("reopen: the same late banned line -> 409 ORDER_CHANGED_DURING_EDIT, the order stays CANCELLED", async () => {
        const orderId = await seedOrder(w.caCustomerId, [w.clean], {
          status: "CANCELLED",
          lineStatus: "CANCELLED",
        });
        const { blocked, result } = await withBannedLineInsertedUnderLock(orderId, () =>
          as(() => svc.reopenOrder(orderId, staff())),
        );
        expect(blocked).toBe(true);
        expect(result.ok).toBe(false);
        expect(bodyOf((result as { e: unknown }).e).code).toBe("ORDER_CHANGED_DURING_EDIT");
        expect(await statusOf(orderId)).toBe("CANCELLED");
      }, 60_000);

      it("an order with nothing in play still switches (the always-on re-check costs a transaction, not a refusal)", async () => {
        const orderId = await seedOrder(w.txCustomerId, [w.clean]);
        await as(() => svc.updateFulfillPath(orderId, { fulfillPath: "SHIP" } as never, staff()));
        expect(await pathOf(orderId)).toBe("SHIP");
        expect(await audits(orderId)).toHaveLength(0);
      });
    });
  },
);
