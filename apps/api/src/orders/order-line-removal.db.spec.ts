/**
 * #2563 (SA-507b) — real-Postgres pins THROUGH OrdersService.updateOrderItems(): a staff per-line diff
 * CANCEL or DELETE naming ANOTHER order's line id is a 404 and writes nothing — the foreign line and
 * its order stay byte-identical, and the edited order's own lines are untouched (the 404 is thrown
 * inside the edit's transaction). Red on master: the removal wrote by bare id, so the foreign line
 * was cancelled/deleted while only the URL order was recomputed. A removal of this order's own
 * line still works (control).
 *
 * Builds a REAL OrdersService via `Object.create` (no Nest DI), as buyer-edit-cancelled-line.db.spec.ts
 * does. NOT RUN by the lane that wrote it (DB specs are the prover's): F2's DB lane runs it.
 *
 * SAFETY: one throwaway `qa-2563-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes
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
import { Logger } from "@nestjs/common";
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

describeDb(
  "#2563 — a diff removal writes only a named line of the edited order, real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: any;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-2563-${run}`, "order-line-removal.db.spec.ts");
    let tenantId = "";
    let operatorUserId = "";
    let buyerUserId = "";
    let driverUserId = "";
    let driverId = "";
    const routeIds: string[] = [];
    const runIds: string[] = [];
    let customerId = "";
    const productIds: string[] = [];
    const orderIds: string[] = [];

    const principal = (role: "OPERATOR" | "DRIVER", sub: string): JwtPayload =>
      ({
        sub,
        username: `${role.toLowerCase()}-${run}`,
        role,
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId,
        tenantSlug: slug,
      }) as JwtPayload;

    /** A 6-piece Box product at $10 a box (stocked), with a Case of 12 at $18 on its ladder. */
    async function product(tag: string) {
      const p = await raw.product.create({
        data: {
          name: `${tag} cola ${run}`,
          unit: "Box",
          pricePerUnit: "10.00",
          unitsPerBox: 6,
          currentStock: "10000",
          tenantId,
        },
      });
      productIds.push(p.id);
      await raw.productUnit.create({
        data: { tenantId, productId: p.id, label: "Case", factorToBase: 12, price: "18.00" },
      });
      return p.id;
    }

    const operator = () => principal("OPERATOR", operatorUserId);
    const driver = () => principal("DRIVER", driverUserId);

    /** SA-429: the driver's own IN_PROGRESS run and a PENDING stop, so a driver may edit the order. */
    async function driverStop(): Promise<{ routeRunId: string; routeRunStopId: string }> {
      const route = await raw.route.create({
        data: { name: `2563 route ${run}-${routeIds.length}`, tenantId } as any,
      });
      routeIds.push(route.id);
      const routeStop = await raw.routeStop.create({
        data: { tenantId, routeId: route.id, stopNumber: 1, customerId } as any,
      });
      const rr = await raw.routeRun.create({
        data: {
          tenantId,
          routeId: route.id,
          scheduledDate: new Date("2026-09-27T00:00:00.000Z"),
          status: "IN_PROGRESS" as any,
          driverId,
        },
      });
      runIds.push(rr.id);
      const stop = await raw.routeRunStop.create({
        data: {
          tenantId,
          routeRunId: rr.id,
          routeStopId: routeStop.id,
          stopNumber: 1,
          status: "PENDING" as any,
        } as any,
      });
      return { routeRunId: rr.id, routeRunStopId: stop.id };
    }

    async function order(
      lines: any | any[],
      stop?: { routeRunId: string; routeRunStopId: string },
    ) {
      const list = Array.isArray(lines) ? lines : [lines];
      const o = await raw.order.create({
        data: {
          customerId,
          tenantId,
          status: "PENDING",
          subtotal: "20.00",
          total: "20.00",
          ...(stop ?? {}),
          lineItems: { create: list.map((l) => ({ tenantId, ...l })) },
        },
        include: { lineItems: true },
      });
      orderIds.push(o.id);
      return o;
    }

    const edit = (orderId: string, dto: any, who: JwtPayload = operator()) =>
      tenantCtx.run(tenantId, () => orders.updateOrderItems(orderId, dto, who));
    /** The whole order as stored: its header money and every line (ids included). */
    const snapshot = async (orderId: string) => ({
      header: await raw.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { subtotal: true, total: true, status: true },
      }),
      lines: await rows(orderId),
    });
    const rows = (orderId: string) =>
      raw.orderItem.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
    const stock = async (id: string) =>
      Number((await raw.product.findUniqueOrThrow({ where: { id } })).currentStock);

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
      tenantId = (await raw.tenant.create({ data: { slug, name: `2563 ${slug}` } })).id;
      operatorUserId = (
        await raw.user.create({
          data: {
            email: `o-${run}@example.test`,
            username: `o-${run}`,
            role: "OPERATOR",
            tenantId,
          },
        })
      ).id;
      buyerUserId = (
        await raw.user.create({
          data: {
            email: `b-${run}@example.test`,
            username: `b-${run}`,
            role: "CUSTOMER",
            tenantId,
          },
        })
      ).id;
      customerId = (
        await raw.customer.create({
          data: { userId: buyerUserId, businessName: "2563 co", contactName: "Tester", tenantId },
        })
      ).id;
      driverUserId = (
        await raw.user.create({
          data: { email: `d-${run}@example.test`, username: `d-${run}`, role: "DRIVER", tenantId },
        })
      ).id;
      driverId = (await raw.driver.create({ data: { userId: driverUserId, tenantId } as any })).id;
    }, 120_000);

    afterAll(async () => {
      await raw.orderRevision?.deleteMany?.({ where: { orderId: { in: orderIds } } });
      await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.order.deleteMany({ where: { id: { in: orderIds } } });
      await raw.routeRunStop.deleteMany({ where: { routeRunId: { in: runIds } } });
      await raw.routeRun.deleteMany({ where: { id: { in: runIds } } });
      await raw.routeStop.deleteMany({ where: { routeId: { in: routeIds } } });
      await raw.route.deleteMany({ where: { id: { in: routeIds } } });
      await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
      await raw.productUnit.deleteMany({ where: { productId: { in: productIds } } });
      await raw.product.deleteMany({ where: { id: { in: productIds } } });
      await raw.customer.deleteMany({ where: { id: customerId } });
      await raw.driver.deleteMany({ where: { tenantId } });
      await raw.user.deleteMany({
        where: { id: { in: [operatorUserId, buyerUserId, driverUserId] } },
      });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    /** A plain 6-piece Box line: 1 box at $10. */
    const packLine = (productId: string) => ({
      productId,
      qty: 6,
      boxes: 1,
      pieces: 0,
      unitsPerBox: 6,
      unitPrice: "10.00",
      subtotal: "10.00",
    });

    const cases = [
      ["OPERATOR", "CANCEL"],
      ["OPERATOR", "DELETE"],
      ["DRIVER", "CANCEL"],
      ["DRIVER", "DELETE"],
    ] as const;
    const as = async (role: "OPERATOR" | "DRIVER") =>
      role === "DRIVER"
        ? { who: driver(), stop: await driverStop() }
        : { who: operator(), stop: undefined };

    it.each(cases)(
      "%s %s naming ANOTHER order's line is a 404; both orders (header + lines) byte-identical",
      async (role, action) => {
        const cola = await product(`foreign-${role}-${action}`);
        const { who, stop } = await as(role);
        const mine = await order(packLine(cola), stop);
        const other = await order(packLine(cola));
        const [mineBefore, otherBefore] = [await snapshot(mine.id), await snapshot(other.id)];
        const stockBefore = await stock(cola);
        await expect(
          edit(mine.id, { replaceAll: false, items: [{ id: other.lineItems[0].id, action }] }, who),
        ).rejects.toMatchObject({ status: 404 });
        expect(await snapshot(other.id)).toEqual(otherBefore);
        expect(await snapshot(mine.id)).toEqual(mineBefore);
        expect(await stock(cola)).toBe(stockBefore);
      },
    );

    // Lead Opus FAIL on #2573 / SA-511c: Prisma drops an undefined key, so an id-less removal's
    // `{ id: undefined, orderId }` matched EVERY line of the order and struck them all off.
    it.each(cases)(
      "%s id-less %s on a multi-line order is a 400; every line and the header byte-identical",
      async (role, action) => {
        const cola = await product(`idless-${role}-${action}`);
        const chips = await product(`idless2-${role}-${action}`);
        const { who, stop } = await as(role);
        const o = await order([packLine(cola), packLine(chips)], stop);
        const before = await snapshot(o.id);
        await expect(
          edit(o.id, { replaceAll: false, items: [{ action }] }, who),
        ).rejects.toMatchObject({ status: 400 });
        expect(await snapshot(o.id)).toEqual(before);
        expect(before.lines).toHaveLength(2);
      },
    );

    // #2577 (sibling of #2563): a SUBSTITUTE rewrites a line — scoped to THIS order like a removal.
    it.each([
      ["OPERATOR", "pack"],
      ["DRIVER", "pack"],
      ["OPERATOR", "Case"],
    ] as const)(
      "%s %s substitute naming ANOTHER order's line is a 404; both orders byte-identical",
      async (role, unit) => {
        const cola = await product(`sub-${role}-${unit}`);
        const chips = await product(`sub2-${role}-${unit}`);
        const { who, stop } = await as(role);
        const mine = await order(packLine(cola), stop);
        const other = await order(packLine(cola));
        const [mineBefore, otherBefore] = [await snapshot(mine.id), await snapshot(other.id)];
        const item = {
          id: other.lineItems[0].id,
          substituteProductId: chips,
          qty: 12,
          ...(unit === "Case" ? { unitLabel: "Case" } : {}),
        };
        await expect(
          edit(mine.id, { replaceAll: false, items: [item] }, who),
        ).rejects.toMatchObject({
          status: 404,
        });
        expect(await snapshot(other.id)).toEqual(otherBefore);
        expect(await snapshot(mine.id)).toEqual(mineBefore);
      },
    );

    it("an id-less substitute is a 400 and writes nothing", async () => {
      const cola = await product("sub-idless");
      const chips = await product("sub-idless2");
      const o = await order([packLine(cola), packLine(chips)]);
      const before = await snapshot(o.id);
      await expect(
        edit(o.id, { replaceAll: false, items: [{ substituteProductId: chips, qty: 6 }] }),
      ).rejects.toMatchObject({ status: 400 });
      expect(await snapshot(o.id)).toEqual(before);
    });

    it("an id-less item with NO action is an ADD, not a removal: staff still creates the line", async () => {
      const cola = await product("add");
      const chips = await product("add2");
      const o = await order(packLine(cola));
      await edit(o.id, { replaceAll: false, items: [{ productId: chips, qty: 6 }] });
      const after = await rows(o.id);
      expect(after).toHaveLength(2);
      expect(after.map((r) => r.productId)).toEqual(expect.arrayContaining([cola, chips]));
    });

    it("control: a CANCEL / DELETE of this order's own line still works", async () => {
      const cola = await product("own");
      const o = await order(packLine(cola));
      await edit(o.id, { replaceAll: false, items: [{ id: o.lineItems[0].id, action: "CANCEL" }] });
      expect((await rows(o.id))[0].status).toBe("CANCELLED");
      const o2 = await order(packLine(cola));
      await edit(o2.id, {
        replaceAll: false,
        items: [{ id: o2.lineItems[0].id, action: "DELETE" }],
      });
      expect(await rows(o2.id)).toEqual([]);
    });
  },
);
