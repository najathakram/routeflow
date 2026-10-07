/**
 * B1050 (SA-703) — real-Postgres pins THROUGH OrdersService.updateOrderItems(): an edit may drop a line's
 * qty below its deliveredQty (never rewritten); stock books max(qty, delivered) per matched line, a
 * struck delivered line never nets against a NEW line, and a replace-all (deleteMany + re-create)
 * pools. Every case also asserts the SALE ledger explains the counter move.
 *
 * Builds a REAL OrdersService via `Object.create` (no Nest DI), as order-line-removal.db.spec.ts does.
 * NOT RUN by the lane that wrote it (the DB is blocked locally; F2's DB lane runs it).
 *
 * SAFETY: one throwaway `qa-b1050-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("B1050 — delivered-qty edits book max(qty, delivered) per line, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-b1050-${run}`, "b1050-delivered-edit.db.spec.ts");
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
  const driver = () => principal("DRIVER", driverUserId);

  /** SA-429: the driver's own IN_PROGRESS run and a PENDING stop, so a driver may edit the order. */
  async function driverStop(): Promise<{ routeRunId: string; routeRunStopId: string }> {
    const route = await raw.route.create({
      data: { name: `b1050 route ${run}-${routeIds.length}`, tenantId } as any,
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

  async function order(lines: any | any[], stop?: { routeRunId: string; routeRunStopId: string }) {
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
        reconcileOrderDraftInvoice: async () => undefined,
      },
      logger: new Logger(OrdersService.name),
      inlineReturns: {},
      creditNotes: { settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }) },
    });
    tenantId = (await raw.tenant.create({ data: { slug, name: `b1050 ${slug}` } })).id;
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
        data: { userId: buyerUserId, businessName: "b1050 co", contactName: "Tester", tenantId },
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

  /** A plain line: qty at $1, with a delivered qty (the order's own lines are already out of stock). */
  const plain = (productId: string, qty: number, deliveredQty = 0) => ({
    productId,
    qty,
    deliveredQty,
    unitPrice: "1.00",
    subtotal: String(qty),
  });
  /** The counter moved by exactly what the SALE rows say (the order's opening 10 predate the ledger). */
  const ledgerNet = async (productId: string) =>
    (await raw.stockMovement.findMany({ where: { productId } })).reduce(
      (s, m) => s + Number(m.quantity),
      0,
    );

  it("repro-1: {q10,d10} → 6 → 10 moves nothing (counter 90, ledger net 0)", async () => {
    const p = await product("repro1");
    const o = await order(plain(p, 10, 10));
    const id = o.lineItems[0].id;
    await edit(o.id, { replaceAll: false, items: [{ id, qty: 6 }] });
    expect(await stock(p)).toBe(90);
    await edit(o.id, { replaceAll: false, items: [{ id, qty: 10 }] });
    expect(await stock(p)).toBe(90);
    expect(await ledgerNet(p)).toBe(0);
  });

  it("raise: {q2,d4} → 10 decrements 6 (not 8); the ledger agrees", async () => {
    const p = await product("raise");
    const o = await order(plain(p, 2, 4));
    await edit(o.id, { replaceAll: false, items: [{ id: o.lineItems[0].id, qty: 10 }] });
    expect(await stock(p)).toBe(84);
    expect(await ledgerNet(p)).toBe(-6);
  });

  it("pooled: A{5,d5}+B{5}, strike A, add C{3} decrements 3 (counter 87), not 0", async () => {
    const p = await product("pooled");
    const o = await order([plain(p, 5, 5), plain(p, 5, 0)]);
    await edit(o.id, {
      replaceAll: false,
      items: [
        { id: o.lineItems[0].id, action: "DELETE" },
        { productId: p, qty: 3 },
      ],
    });
    expect(await stock(p)).toBe(87);
    expect(await ledgerNet(p)).toBe(-3);
  });

  it("KNOWN B1167: replace-all recreates its lines WITHOUT deliveredQty: {x,10,d10} → [6] writes nothing; → [12] books 6", async () => {
    // B1167 (known residual, owner ruling "fix the math only"): replace-all deletes and re-creates every
    // line with deliveredQty reset to 0, so the first edit pools max(6, 10) = 10 (no write) but the
    // second compares against the new line's own q = 6 and decrements 6 (stock 84, ledger −6), not 2.
    const p = await product("replace-all");
    const o = await order(plain(p, 10, 10));
    await edit(o.id, { replaceAll: true, items: [{ productId: p, qty: 6, unitPrice: "1.00" }] });
    expect(await stock(p)).toBe(90);
    await edit(o.id, { replaceAll: true, items: [{ productId: p, qty: 12, unitPrice: "1.00" }] });
    expect(await stock(p)).toBe(84);
    expect(await ledgerNet(p)).toBe(-6);
  });
});
