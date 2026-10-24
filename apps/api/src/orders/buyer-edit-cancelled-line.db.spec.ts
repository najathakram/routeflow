/**
 * SA-422 (#2320) — real-Postgres pins THROUGH OrdersService.updateOrderItems(): a buyer order edit can
 * never revive a seller-CANCELLED line. Buyer full replace: a payload naming a product whose only
 * lines are CANCELLED ⇒ 409 LINE_CANCELLED_BY_SELLER with zero writes; a live sibling of the same
 * product is accepted and denominated by the LIVE line; a pack-only echo is value-identical; the
 * CANCELLED row count never changes on a buyer save. Diff path (a DRIVER today): UPDATE on a cancelled
 * id ⇒ the same 409; CANCEL on it ⇒ a 200 no-op.
 *
 * Builds a REAL OrdersService via `Object.create` (no Nest DI), as orders-inline-return-edit.db.spec.ts
 * does. NOT RUN by the lane that wrote it (DB specs are the prover's): F2's DB lane runs it and adjusts
 * any fixture field the schema demands.
 *
 * SAFETY: one throwaway `qa-2320-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes
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
  "SA-422 (#2320) — a buyer edit never revives a seller-CANCELLED line, real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: any;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-2320-${run}`, "buyer-edit-cancelled-line.db.spec.ts");
    let tenantId = "";
    let buyerUserId = "";
    let driverUserId = "";
    let driverId = "";
    const routeIds: string[] = [];
    const runIds: string[] = [];
    let customerId = "";
    const productIds: string[] = [];
    const orderIds: string[] = [];

    const principal = (role: "CUSTOMER" | "DRIVER", sub: string): JwtPayload =>
      ({
        sub,
        username: `${role.toLowerCase()}-${run}`,
        role,
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId,
        tenantSlug: slug,
      }) as JwtPayload;
    const buyer = () => principal("CUSTOMER", buyerUserId);
    const driver = () => principal("DRIVER", driverUserId);

    /** A 6-piece Box product at $10 a box (stocked), with a Case of 12 on its ladder. */
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

    /** A PENDING order with the given lines (each already shaped as an OrderItem create). */
    async function order(lines: any[], stop?: { routeRunId: string; routeRunStopId: string }) {
      const o = await raw.order.create({
        data: {
          customerId,
          tenantId,
          status: "PENDING",
          subtotal: "0.00",
          total: "0.00",
          ...(stop ?? {}),
          lineItems: { create: lines.map((l) => ({ tenantId, ...l })) },
        },
        include: { lineItems: true },
      });
      orderIds.push(o.id);
      return o;
    }

    /** A seller-cancelled 3-Case line of `productId` (qty kept as the reopen mark). */
    const cancelledCase = (productId: string) => ({
      productId,
      unitLabel: "Case",
      unitsPerBox: 12,
      qty: 36,
      boxes: 3,
      pieces: 0,
      unitPrice: "18.00",
      subtotal: "54.00",
      status: "CANCELLED",
    });

    /**
     * SA-429 (#2386): a DRIVER edits only an order on a stop of their own IN_PROGRESS run, with the stop
     * PENDING or IN_PROGRESS. The ALLOWED fixture: the driver's run, a PENDING stop the order sits on.
     */
    async function driverStop(): Promise<{ routeRunId: string; routeRunStopId: string }> {
      const route = await raw.route.create({
        data: { name: `2320 route ${run}`, tenantId } as any,
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

    const edit = (orderId: string, dto: any, who: JwtPayload) =>
      tenantCtx.run(tenantId, () => orders.updateOrderItems(orderId, dto, who));
    const rows = (orderId: string) =>
      raw.orderItem.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
    const cancelledCount = (orderId: string) =>
      raw.orderItem.count({ where: { orderId, status: "CANCELLED" } });
    const stock = async (id: string) =>
      Number((await raw.product.findUniqueOrThrow({ where: { id } })).currentStock);
    const money = (r: any) => ({
      productId: r.productId,
      qty: Number(r.qty),
      boxes: r.boxes,
      pieces: r.pieces,
      unitPrice: Number(r.unitPrice),
      subtotal: Number(r.subtotal),
      status: r.status,
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
      tenantId = (await raw.tenant.create({ data: { slug, name: `2320 ${slug}` } })).id;
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
      driverUserId = (
        await raw.user.create({
          data: { email: `d-${run}@example.test`, username: `d-${run}`, role: "DRIVER", tenantId },
        })
      ).id;
      driverId = (await raw.driver.create({ data: { userId: driverUserId, tenantId } as any })).id;
      customerId = (
        await raw.customer.create({
          data: { userId: buyerUserId, businessName: "2320 co", contactName: "Tester", tenantId },
        })
      ).id;
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
      await raw.user.deleteMany({ where: { id: { in: [buyerUserId, driverUserId] } } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    it("a cancelled Case line + a payload naming its product: 409 LINE_CANCELLED_BY_SELLER, zero writes", async () => {
      const cola = await product("revive");
      const chips = await product("chips");
      const o = await order([
        cancelledCase(cola),
        {
          productId: chips,
          qty: 6,
          boxes: 1,
          pieces: 0,
          unitsPerBox: 6,
          unitPrice: "10.00",
          subtotal: "10.00",
        },
      ]);
      const before = await rows(o.id); // full rows, ids included (Opus N2)
      const stockBefore = await stock(cola);
      await expect(
        edit(
          o.id,
          {
            items: [
              { productId: cola, qty: 24 },
              { productId: chips, qty: 6 },
            ],
          },
          buyer(),
        ),
      ).rejects.toMatchObject({ response: { code: "LINE_CANCELLED_BY_SELLER", productId: cola } });
      expect(await rows(o.id)).toEqual(before);
      expect(await stock(cola)).toBe(stockBefore);
    });

    it("a cancelled line + a LIVE sibling of the same product: accepted, denominated by the live line", async () => {
      const cola = await product("sibling");
      // The live line is box-UNAWARE (qty = 2 boxes, no split); the cancelled Case line has a split.
      const o = await order([
        cancelledCase(cola),
        { productId: cola, qty: 2, unitPrice: "10.00", subtotal: "20.00" },
      ]);
      const cancelled = await cancelledCount(o.id);
      await edit(o.id, { items: [{ productId: cola, qty: 2 }] }, buyer());
      const live = (await rows(o.id)).filter((r) => r.status !== "CANCELLED");
      expect(live).toHaveLength(1);
      // A cancelled line deciding the denomination would have read qty 2 as 2 PIECES ($3.33).
      expect(live[0].boxes).toBeNull();
      expect(Number(live[0].qty)).toBe(2);
      expect(Number(live[0].subtotal)).toBe(20);
      expect(await cancelledCount(o.id)).toBe(cancelled);
    });

    it("a pack-only echo is value-identical, and the CANCELLED row survives the buyer save", async () => {
      const cola = await product("echo");
      const chips = await product("echo-chips");
      const o = await order([
        cancelledCase(chips),
        {
          productId: cola,
          qty: 6,
          boxes: 1,
          pieces: 0,
          unitsPerBox: 6,
          unitPrice: "10.00",
          subtotal: "10.00",
        },
      ]);
      const cancelledBefore = (await rows(o.id)).filter((r) => r.status === "CANCELLED"); // full row (N2)
      const liveBefore = (await rows(o.id)).filter((r) => r.status !== "CANCELLED").map(money);
      await edit(o.id, { items: [{ productId: cola, qty: 6 }] }, buyer());
      expect((await rows(o.id)).filter((r) => r.status !== "CANCELLED").map(money)).toEqual(
        liveBefore,
      );
      expect((await rows(o.id)).filter((r) => r.status === "CANCELLED")).toEqual(cancelledBefore);
    });

    it("diff path (DRIVER): UPDATE on a cancelled id is a 409; CANCEL on it is a 200 no-op", async () => {
      const cola = await product("diff");
      // SA-429: the driver's own IN_PROGRESS run and PENDING stop, so ownership passes and the
      // cancelled-line rule is what answers.
      const o = await order([cancelledCase(cola)], await driverStop());
      const cancelledId = o.lineItems[0].id;
      const before = await rows(o.id); // full rows, ids included (Opus N2)
      await expect(
        edit(o.id, { replaceAll: false, items: [{ id: cancelledId, qty: 1 }] }, driver()),
      ).rejects.toMatchObject({ response: { code: "LINE_CANCELLED_BY_SELLER" } });
      const res = await edit(
        o.id,
        { replaceAll: false, items: [{ id: cancelledId, action: "CANCEL" }] },
        driver(),
      );
      expect(res?.id).toBe(o.id);
      expect(await rows(o.id)).toEqual(before);
    });
  },
);
