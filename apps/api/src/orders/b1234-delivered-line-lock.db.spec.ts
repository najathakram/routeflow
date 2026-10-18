/**
 * B1234 (D-O2-a) - real-Postgres pins THROUGH OrdersService.updateOrderItems(): on a PARTIALLY_DELIVERED order a line
 * the driver delivered (deliveredQty > 0) cannot be cut, deleted, cancelled, substituted, re-united or replaced:
 * 409 LINE_ALREADY_DELIVERED, and the stock counter, the ledger, the lines and the header are exactly as before.
 * The undelivered line stays editable and a note on the delivered line is allowed. A stale pre-tx read (the line
 * looked undelivered, a delivery landed before the Order lock) is refused on the LOCKED read.
 *
 * Builds a REAL OrdersService via `Object.create` (no Nest DI), as b1050-delivered-edit.db.spec.ts does.
 * NOT RUN by the lane that wrote it (Docker/DB down); the DB lane runs it.
 *
 * SAFETY: one throwaway `qa-b1234-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes
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
  "B1234 — a delivered line of a PARTIALLY_DELIVERED order is locked, real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: any;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-b1234-${run}`, "b1234-delivered-line-lock.db.spec.ts");
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

    /** A plain "ea" product (no box, no unit ladder) holding 90 pieces: the order's own 10 are already out. */
    async function product(tag: string) {
      const p = await raw.product.create({
        data: {
          name: `${tag} cola ${run}`,
          unit: "ea",
          pricePerUnit: "1.00",
          currentStock: "90",
          tenantId,
        },
      });
      productIds.push(p.id);
      return p.id;
    }

    const operator = () => principal("OPERATOR", operatorUserId);

    async function order(lines: any | any[], status = "PENDING") {
      const list = Array.isArray(lines) ? lines : [lines];
      const o = await raw.order.create({
        data: {
          customerId,
          tenantId,
          status: status as any,
          subtotal: "20.00",
          total: "20.00",
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
      tenantId = (await raw.tenant.create({ data: { slug, name: `b1234 ${slug}` } })).id;
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
          data: { userId: buyerUserId, businessName: "b1234 co", contactName: "Tester", tenantId },
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

    /** A plain line: qty at $1, with a delivered qty. */
    const plain = (productId: string, qty: number, deliveredQty = 0) => ({
      productId,
      qty,
      deliveredQty,
      unitPrice: "1.00",
      subtotal: String(qty),
    });
    const ledgerRows = (productId: string) => raw.stockMovement.findMany({ where: { productId } });
    const REFUSED = { response: { code: "LINE_ALREADY_DELIVERED" }, status: 409 };

    /** A: 5 ordered, 3 delivered. B: 4 ordered, undelivered. Status PARTIALLY_DELIVERED. */
    async function pdOrder() {
      const p = await product("pd");
      const o = await order([plain(p, 5, 3), plain(p, 4, 0)], "PARTIALLY_DELIVERED");
      const a = o.lineItems.find((l) => Number(l.deliveredQty) > 0)!;
      const b = o.lineItems.find((l) => Number(l.deliveredQty) === 0)!;
      return { p, o, a, b };
    }

    /** Refused edit: 409, and stock, ledger, lines and header are identical afterwards. */
    async function expectRefused(build: (ctx: { p: string; a: { id: string } }) => any) {
      const { p, o, a } = await pdOrder();
      const dto = build({ p, a });
      const before = await snapshot(o.id);
      const stockBefore = await stock(p);
      const ledgerBefore = (await ledgerRows(p)).length;
      await expect(edit(o.id, dto)).rejects.toMatchObject(REFUSED);
      expect(await snapshot(o.id)).toEqual(before);
      expect(await stock(p)).toBe(stockBefore);
      expect((await ledgerRows(p)).length).toBe(ledgerBefore);
    }

    it("A qty 5 to 2 (below what was delivered) is refused, nothing moves", async () => {
      await expectRefused(({ a }) => ({ replaceAll: false, items: [{ id: a.id, qty: 2 }] }));
    });
    it("A qty raised is refused too", async () => {
      await expectRefused(({ a }) => ({ replaceAll: false, items: [{ id: a.id, qty: 9 }] }));
    });
    it("DELETE A is refused", async () => {
      await expectRefused(({ a }) => ({
        replaceAll: false,
        items: [{ id: a.id, action: "DELETE" }],
      }));
    });
    it("CANCEL A (Not available) is refused", async () => {
      await expectRefused(({ a }) => ({
        replaceAll: false,
        items: [{ id: a.id, action: "CANCEL" }],
      }));
    });
    it("substituting A is refused", async () => {
      const other = await product("other");
      await expectRefused(({ a }) => ({
        replaceAll: false,
        items: [{ id: a.id, substituteProductId: other }],
      }));
    });
    it("a unit change on A is refused", async () => {
      await expectRefused(({ a }) => ({
        replaceAll: false,
        items: [{ id: a.id, qty: 5, unitLabel: "Case" }],
      }));
    });
    it("a price change on A is refused", async () => {
      await expectRefused(({ a }) => ({
        replaceAll: false,
        items: [{ id: a.id, qty: 5, unitPrice: "2.00" }],
      }));
    });
    it("any replace-all is refused (replace modes fail closed)", async () => {
      await expectRefused(({ p }) => ({
        replaceAll: true,
        items: [{ productId: p, qty: 5, unitPrice: "1.00" }],
      }));
    });

    it("control: B (undelivered) is still editable, A untouched", async () => {
      const { o, a, b } = await pdOrder();
      await edit(o.id, { replaceAll: false, items: [{ id: b.id, qty: 2 }] });
      const after = await rows(o.id);
      expect(Number(after.find((l) => l.id === b.id)!.qty)).toBe(2);
      expect(Number(after.find((l) => l.id === a.id)!.qty)).toBe(5);
      expect(Number(after.find((l) => l.id === a.id)!.deliveredQty)).toBe(3);
    });

    it("a note-only change on A is allowed and changes nothing else", async () => {
      const { p, o, a } = await pdOrder();
      const stockBefore = await stock(p);
      await edit(o.id, { replaceAll: false, items: [{ id: a.id, notes: "gate code 4412" }] });
      const after = (await rows(o.id)).find((l) => l.id === a.id)!;
      expect(after.notes).toBe("gate code 4412");
      expect(Number(after.qty)).toBe(5);
      expect(await stock(p)).toBe(stockBefore);
    });

    it("stale status: the pre-tx read shows CONFIRMED, a delivery flips the order to PARTIALLY_DELIVERED, the LOCKED status refuses", async () => {
      const p = await product("flip");
      const o = await order([plain(p, 5, 0), plain(p, 4, 0)], "CONFIRMED");
      const target = o.lineItems.find((l) => Number(l.qty) === 5)!;
      const before = await snapshot(o.id);
      const stockBefore = await stock(p);
      // The first read of the order (the pre-tx one) returns CONFIRMED, then the delivery lands before the Order lock.
      const orderModel = (prisma as any).order;
      const real = orderModel.findUnique.bind(orderModel);
      let landed = false;
      const spy = jest
        .spyOn(orderModel, "findUnique")
        .mockImplementation(async (...args: any[]) => {
          const res = await real(...args);
          if (!landed) {
            landed = true;
            await raw.orderItem.update({ where: { id: target.id }, data: { deliveredQty: "3" } });
            await raw.order.update({
              where: { id: o.id },
              data: { status: "PARTIALLY_DELIVERED" },
            });
          }
          return res;
        });
      try {
        await expect(
          edit(o.id, { replaceAll: false, items: [{ id: target.id, qty: 2 }] }),
        ).rejects.toMatchObject(REFUSED);
      } finally {
        spy.mockRestore();
      }
      const after = await snapshot(o.id);
      const lineAfter = after.lines.find((l) => l.id === target.id)!;
      expect(Number(lineAfter.qty)).toBe(5);
      expect(Number(lineAfter.deliveredQty)).toBe(3);
      expect(after.header).toEqual({ ...before.header, status: "PARTIALLY_DELIVERED" });
      expect(await stock(p)).toBe(stockBefore);
    });

    it("stale read: the pre-tx read shows A undelivered, a delivery lands, the LOCKED read refuses", async () => {
      const p = await product("stale");
      const o = await order([plain(p, 5, 0), plain(p, 4, 0)], "PARTIALLY_DELIVERED");
      const target = o.lineItems.find((l) => Number(l.qty) === 5)!;
      const before = await snapshot(o.id);
      const stockBefore = await stock(p);
      // The first read of the order (the pre-tx one) returns, then the driver's delivery lands before the Order lock.
      const orderModel = (prisma as any).order;
      const real = orderModel.findUnique.bind(orderModel);
      let landed = false;
      const spy = jest
        .spyOn(orderModel, "findUnique")
        .mockImplementation(async (...args: any[]) => {
          const res = await real(...args);
          if (!landed) {
            landed = true;
            await raw.orderItem.update({ where: { id: target.id }, data: { deliveredQty: "3" } });
          }
          return res;
        });
      try {
        await expect(
          edit(o.id, { replaceAll: false, items: [{ id: target.id, qty: 2 }] }),
        ).rejects.toMatchObject(REFUSED);
      } finally {
        spy.mockRestore();
      }
      const after = await snapshot(o.id);
      const lineAfter = after.lines.find((l) => l.id === target.id)!;
      expect(Number(lineAfter.qty)).toBe(5);
      expect(Number(lineAfter.deliveredQty)).toBe(3);
      expect(after.header).toEqual(before.header);
      expect(await stock(p)).toBe(stockBefore);
    });
  },
);
