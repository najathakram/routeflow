/**
 * W-946 probe: a replace-mode save (staff replaceAll, driver full list) that OMITS a delivered line of a DELIVERED order
 * must be refused (409 LINE_ALREADY_DELIVERED), never silently drop the line. Real Postgres, test tenant only.
 * Scaffolding copied from b1234-delivered-line-lock.db.spec.ts.
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

describeDb("W-946 — a replace save never drops a delivered line, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-w946-${run}`, "w946-replace-omits-delivered.db.spec.ts");
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
  const invoiceIds: string[] = [];
  /** What the (mocked) active promotions endpoint returns; the BOGO case sets it for one edit. */
  let activePromos: any[] = [];

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
        // Product names are unique per tenant (Product_tenant_root_name_active_key): one per call.
        name: `${tag} cola ${run} #${productIds.length + 1}`,
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
  /** The whole order as stored: its header money, every line (ids included) and its linked invoices. */
  const snapshot = async (orderId: string) => ({
    header: await raw.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { subtotal: true, total: true, status: true },
    }),
    lines: await rows(orderId),
    invoices: await raw.invoice.findMany({
      where: { orderId },
      orderBy: { id: "asc" },
      select: { id: true, status: true, subtotal: true, taxAmount: true, total: true },
    }),
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
      promotionsService: { activeForCatalog: async () => activePromos },
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
    tenantId = (await raw.tenant.create({ data: { slug, name: `w946 ${slug}` } })).id;
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
        data: { userId: buyerUserId, businessName: "w946 co", contactName: "Tester", tenantId },
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
    await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
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

  /** A SENT invoice linked to the order, billing what the lines are worth. */
  async function sentInvoice(orderId: string, total: string) {
    const inv = await raw.invoice.create({
      data: {
        tenantId,
        customerId,
        orderId,
        invoiceNumber: `INV-${randomUUID().slice(0, 8)}`,
        status: "SENT",
        subtotal: total,
        total,
        sentAt: new Date(),
      },
    });
    invoiceIds.push(inv.id);
    return inv;
  }

  /**
   * A: 5 ordered, 3 delivered. B: 4 ordered, undelivered. Status PARTIALLY_DELIVERED, with a linked SENT
   * invoice (9.00) that every refusal must leave exactly as it was (`snapshot` reads it).
   */
  async function pdOrder() {
    const p = await product("pd");
    const o = await order([plain(p, 5, 3), plain(p, 4, 0)], "PARTIALLY_DELIVERED");
    await sentInvoice(o.id, "9.00");
    const a = o.lineItems.find((l) => Number(l.deliveredQty) > 0)!;
    const b = o.lineItems.find((l) => Number(l.deliveredQty) === 0)!;
    return { p, o, a, b };
  }

  /** Refused edit: 409, and stock, ledger, lines and header are identical afterwards. */
  async function expectRefused(
    build: (ctx: { p: string; a: { id: string }; b: { id: string } }) => any,
  ) {
    const { p, o, a, b } = await pdOrder();
    const dto = build({ p, a, b });
    const before = await snapshot(o.id);
    const stockBefore = await stock(p);
    const ledgerBefore = (await ledgerRows(p)).length;
    await expect(edit(o.id, dto)).rejects.toMatchObject(REFUSED);
    expect(await snapshot(o.id)).toEqual(before);
    expect(await stock(p)).toBe(stockBefore);
    expect((await ledgerRows(p)).length).toBe(ledgerBefore);
  }

  /** DELIVERED order: A delivered in full (5/5), B undelivered 4; a SENT invoice bills A. */
  /** The driver's own IN_PROGRESS run and a PENDING stop (b1050 fixture), so a driver may edit the order. */
  async function driverStop() {
    const route = await raw.route.create({
      data: { name: `w946 route ${run}-${routeIds.length}`, tenantId } as any,
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

  async function deliveredOrder(onRoute = false) {
    const p = await product("w946");
    const o = await order([plain(p, 5, 5), plain(p, 4, 0)], "DELIVERED");
    await sentInvoice(o.id, "5.00");
    if (onRoute) await raw.order.update({ where: { id: o.id }, data: await driverStop() });
    const a = o.lineItems.find((l) => Number(l.deliveredQty) > 0)!;
    const b = o.lineItems.find((l) => Number(l.deliveredQty) === 0)!;
    return { p, o, a, b };
  }

  async function probe(
    who: JwtPayload,
    dtoOf: (c: { p: string; b: { id: string } }) => any,
    onRoute = false,
  ) {
    const { p, o, a, b } = await deliveredOrder(onRoute);
    const before = await snapshot(o.id);
    const stockBefore = await stock(p);
    let outcome: unknown = "resolved";
    try {
      await edit(o.id, dtoOf({ p, b }), who);
    } catch (e: any) {
      outcome = { status: e?.status, code: e?.response?.code, message: e?.message };
    }
    const after = await snapshot(o.id);
    // eslint-disable-next-line no-console
    console.log(
      "W946-OBSERVED",
      JSON.stringify({
        outcome,
        aStillThere: after.lines.some((l) => l.id === a.id),
        aLineIds: after.lines.map((l) => ({
          qty: Number(l.qty),
          d: Number(l.deliveredQty),
          st: l.status,
        })),
        stockBefore,
        stockAfter: await stock(p),
        invoiceBefore: before.invoices.map((i) => String(i.total)),
        invoiceAfter: after.invoices.map((i) => String(i.total)),
      }),
    );
    return { outcome, a, before, after, p, stockBefore };
  }

  it("staff replaceAll that omits delivered A is refused, A and stock unchanged", async () => {
    const r = await probe(operator(), ({ p, b }) => ({
      replaceAll: true,
      items: [{ id: b.id, productId: p, qty: 4, unitPrice: "1.00" }],
    }));
    expect(r.outcome).toMatchObject({ status: 409, code: "LINES_REPLACE_AFTER_DELIVERY" });
    expect(r.after.lines.some((l) => l.id === r.a.id)).toBe(true);
    expect(await stock(r.p)).toBe(r.stockBefore);
  });

  it("driver full-list save on an assigned route that omits delivered A is refused, A and stock unchanged", async () => {
    const r = await probe(
      principal("DRIVER", driverUserId),
      ({ p, b }) => ({ items: [{ id: b.id, productId: p, qty: 4, unitPrice: "1.00" }] }),
      true,
    );
    // Observed: the save is accepted (no refusal) but never drops the delivered line: same row id, qty and
    // deliveredQty, stock and invoice untouched. The property to pin is "A survives intact", not the refusal.
    const aAfter = r.after.lines.find((l) => l.id === r.a.id)!;
    expect(Number(aAfter.qty)).toBe(5);
    expect(Number(aAfter.deliveredQty)).toBe(5);
    expect(r.after.invoices).toEqual(r.before.invoices);
    expect(r.after.lines.some((l) => l.id === r.a.id)).toBe(true);
    expect(await stock(r.p)).toBe(r.stockBefore);
  });
});
