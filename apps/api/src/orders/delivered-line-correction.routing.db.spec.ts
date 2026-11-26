/**
 * SA-1506 PR-1a (Amendment 2 red-first 1, 6, 7, 8, 11 WRITTEN_OFF; SA-1520 R4-G invoice), real Postgres, with a REAL
 * OrdersService AND a REAL InvoicesService (no invoice stubs): an admin corrects a delivered line of a reopened order whose
 * invoice already exists, and the invoice restates in place, keeps its SENT status, and a cut below what was paid is
 * refused with nothing written. Harness of w871-paid-invoice-edit-lock.db.spec.ts.
 *
 * Collected only by jest.db.config.js. SAFETY: one throwaway `qa-sa1506r-<run>` tenant approved by `assertTestTenant`.
 */
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
import { InvoicesService } from "../invoices/invoices.service";
import { lockedCopy } from "./delivered-line-copy";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("SA-1506 PR-1a: a delivered-line correction restates the real invoice", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(
    `qa-sa1506r-${run}`,
    "delivered-line-correction.routing.db.spec.ts",
  );
  let tenantId = "";
  const userIds: string[] = [];
  const customerIds: string[] = [];
  const productIds: string[] = [];
  const orderIds: string[] = [];
  const invoiceIds: string[] = [];
  let adminUserId = "";
  let operatorUserId = "";

  const principal = (role: string, sub: string): JwtPayload =>
    ({
      sub,
      username: `${role.toLowerCase()}-${run}`,
      role,
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    }) as JwtPayload;
  const edit = (orderId: string, dto: any, who?: JwtPayload) =>
    tenantCtx.run(tenantId, () =>
      orders.updateOrderItems(orderId, dto, who ?? principal("TENANT_ADMIN", adminUserId)),
    );

  /** A reopened (CONFIRMED) order with one delivered line of `qty` at 10.00, an office row, and one invoice. */
  async function fixture(opts: {
    status: "SENT" | "PAID" | "WRITTEN_OFF" | "DRAFT";
    qty?: number;
    paid?: number;
    officeRow?: boolean;
  }) {
    const qty = opts.qty ?? 10;
    const u = await raw.user.create({
      data: {
        email: `c${customerIds.length}-${run}@example.test`,
        username: `c${customerIds.length}-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    userIds.push(u.id);
    const c = await raw.customer.create({
      data: { userId: u.id, businessName: "Acme Retail", contactName: "Tester", tenantId },
    });
    customerIds.push(c.id);
    const p = await raw.product.create({
      data: {
        name: `sa1506r cola ${run} #${productIds.length + 1}`,
        unit: "ea",
        pricePerUnit: "10.00",
        currentStock: "90",
        tenantId,
      },
    });
    productIds.push(p.id);
    const total = (qty * 10).toFixed(2);
    const o = await raw.order.create({
      data: {
        customerId: c.id,
        tenantId,
        status: "CONFIRMED",
        subtotal: total,
        total,
        lineItems: {
          create: [
            {
              tenantId,
              productId: p.id,
              qty,
              deliveredQty: qty,
              unitPrice: "10.00",
              subtotal: total,
            },
          ],
        },
      },
      include: { lineItems: true },
    });
    orderIds.push(o.id);
    const li = o.lineItems[0];
    if (opts.officeRow !== false)
      await raw.deliveryMutation.create({
        data: {
          orderId: o.id,
          orderItemId: li.id,
          productId: p.id,
          routeRunStopId: null,
          driverId: null,
          type: "DELIVERED",
          quantityDelivered: qty,
          note: "OFFICE_MARKED",
          tenantId,
        },
      });
    const inv = await raw.invoice.create({
      data: {
        tenantId,
        customerId: c.id,
        orderId: o.id,
        invoiceNumber: `INV-${randomUUID().slice(0, 8)}`,
        status: opts.status,
        subtotal: total,
        total,
        items: {
          create: [
            {
              tenantId,
              orderItemId: li.id,
              productId: p.id,
              description: "cola",
              qty,
              unitPrice: "10.00",
              subtotal: total,
            },
          ],
        } as any,
      },
    });
    invoiceIds.push(inv.id);
    if (opts.paid)
      await raw.invoicePayment.create({
        data: {
          tenantId,
          invoiceId: inv.id,
          amount: opts.paid.toFixed(2),
          method: "CASH",
          status: "PAID",
        } as any,
      });
    return { o, li, inv, productId: p.id };
  }
  const invoiceOf = (id: string) => raw.invoice.findUniqueOrThrow({ where: { id } });
  const invoiceQty = async (id: string) =>
    (await raw.invoiceItem.findMany({ where: { invoiceId: id } })).reduce(
      (s, i) => s + Number(i.qty),
      0,
    );
  const snapshot = async (orderId: string) => ({
    order: await raw.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { subtotal: true, total: true, status: true },
    }),
    lines: await raw.orderItem.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } }),
    rows: await raw.deliveryMutation.findMany({ where: { orderId }, orderBy: { id: "asc" } }),
    invoices: await raw.invoice.findMany({ where: { orderId }, orderBy: { id: "asc" } }),
    items: await raw.invoiceItem.findMany({
      where: { invoice: { orderId } },
      orderBy: { id: "asc" },
    }),
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
    const anyMethod = new Proxy(
      {},
      { get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()) },
    );
    const invoices: any = Object.assign(Object.create(InvoicesService.prototype), {
      prisma,
      creditNotes: { settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }) },
      authority: { can: async () => false },
      ledger: anyMethod,
      gateway: anyMethod,
      commissionEngine: { syncInvoiceCommissionSafe: async () => undefined },
      logger: new Logger("sa1506r-invoices"),
    });
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
      invoicesService: invoices,
      logger: new Logger(OrdersService.name),
      inlineReturns: {},
      creditNotes: {
        settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }),
        previewOrderCreditRelease: async () => [],
        releaseOrderCreditsInTx: async () => undefined,
      },
      notifications: {
        sendToCustomer: jest.fn().mockResolvedValue(undefined),
        sendToUser: jest.fn().mockResolvedValue(1),
      },
      messaging: { notifyEvent: jest.fn().mockResolvedValue(undefined) },
      oversellReader: { read: async () => false },
    });
    tenantId = (await raw.tenant.create({ data: { slug, name: `sa1506r ${slug}` } })).id;
    const user = async (tag: string, role: string) => {
      const id = (
        await raw.user.create({
          data: {
            email: `${tag}-${run}@example.test`,
            username: `${tag}-${run}`,
            role: role as any,
            tenantId,
          },
        })
      ).id;
      userIds.push(id);
      return id;
    };
    adminUserId = await user("a", "TENANT_ADMIN");
    operatorUserId = await user("o", "OPERATOR");
  }, 120_000);

  afterAll(async () => {
    await raw.auditLog.deleteMany({ where: { tenantId } });
    await raw.deliveryMutation.deleteMany({ where: { orderId: { in: orderIds } } });
    await raw.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await raw.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await raw.orderRevision?.deleteMany?.({ where: { orderId: { in: orderIds } } });
    await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await raw.order.deleteMany({ where: { id: { in: orderIds } } });
    await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
    await raw.product.deleteMany({ where: { id: { in: productIds } } });
    await raw.customer.deleteMany({ where: { id: { in: customerIds } } });
    await raw.user.deleteMany({ where: { id: { in: userIds } } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("case 1 + 6: a SENT invoice restates in place on a cut to 8: status SENT, order stays CONFIRMED, invoice bills 8", async () => {
    const { o, li, inv } = await fixture({ status: "SENT" });
    await edit(o.id, { replaceAll: false, items: [{ id: li.id, qty: 8 }] });
    const after = await invoiceOf(inv.id);
    expect(after.status).toBe("SENT"); // wrong value: DRAFT (reverted)
    expect(Number(after.total)).toBe(80); // wrong value: 100 (master refuses, a stub leaves it)
    expect(await invoiceQty(inv.id)).toBe(8);
    expect((await raw.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("CONFIRMED"); // wrong value: PENDING
  }, 60_000);

  it("case 6: an admin raise (qty 12, price 11) restates the SENT invoice too", async () => {
    const { o, li, inv } = await fixture({ status: "SENT" });
    await edit(o.id, { replaceAll: false, items: [{ id: li.id, qty: 12, unitPrice: 11 }] });
    const after = await invoiceOf(inv.id);
    expect(after.status).toBe("SENT");
    expect(Number(after.total)).toBe(132);
    expect((await raw.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("CONFIRMED");
  }, 60_000);

  it("R4-G invoice: a row-less line raised from 12 to 13 bills 13 (no silent shortfall)", async () => {
    const { o, li, inv } = await fixture({ status: "SENT", qty: 12, officeRow: false });
    await edit(o.id, { replaceAll: false, items: [{ id: li.id, qty: 13 }] });
    expect(await invoiceQty(inv.id)).toBe(13);
    expect(
      Number((await raw.orderItem.findUniqueOrThrow({ where: { id: li.id } })).deliveredQty),
    ).toBe(13);
  }, 60_000);

  it("case 8: a PAID invoice cut below what was paid is 409 ORDER_EDIT_WOULD_OVERPAY, nothing written", async () => {
    const { o, li } = await fixture({ status: "PAID", paid: 100 });
    const before = await snapshot(o.id);
    await expect(
      edit(o.id, { replaceAll: false, items: [{ id: li.id, qty: 8 }] }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: "ORDER_EDIT_WOULD_OVERPAY" },
    });
    expect(await snapshot(o.id)).toEqual(before);
  }, 60_000);

  it("case 7: an operator's delivered-line cut is refused, nothing written", async () => {
    const { o, li } = await fixture({ status: "SENT" });
    const before = await snapshot(o.id);
    await expect(
      edit(
        o.id,
        { replaceAll: false, items: [{ id: li.id, qty: 8 }] },
        principal("OPERATOR", operatorUserId),
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: "LINE_ALREADY_DELIVERED" } });
    expect(await snapshot(o.id)).toEqual(before);
  }, 60_000);

  it("case 11 WRITTEN_OFF: an admin cut is refused with the written-off sentence, nothing written", async () => {
    const { o, li, inv } = await fixture({ status: "WRITTEN_OFF" });
    const before = await snapshot(o.id);
    const invoiceNumber = (await invoiceOf(inv.id)).invoiceNumber;
    await expect(
      edit(o.id, { replaceAll: false, items: [{ id: li.id, qty: 8 }] }),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        code: "LINE_ALREADY_DELIVERED",
        message: lockedCopy("WRITTEN_OFF", { invoiceNumber }),
      },
    });
    expect(await snapshot(o.id)).toEqual(before);
  }, 60_000);

  it("case 11 RETURN: a live return on the order locks the line (admin), nothing written, until PR-1c", async () => {
    const { o, li } = await fixture({ status: "SENT" });
    const cust = await raw.order.findUniqueOrThrow({ where: { id: o.id } });
    await raw.return.create({
      data: {
        tenantId,
        customerId: cust.customerId,
        orderId: o.id,
        returnNumber: `RET-${randomUUID().slice(0, 8)}`,
        reason: "DAMAGED",
        status: "PENDING",
        kind: "INLINE",
      } as any,
    });
    const before = await snapshot(o.id);
    await expect(
      edit(o.id, { replaceAll: false, items: [{ id: li.id, qty: 8 }] }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: "LINE_ALREADY_DELIVERED", message: lockedCopy("RETURN") },
    });
    expect(await snapshot(o.id)).toEqual(before);
    await raw.return.deleteMany({ where: { orderId: o.id } });
  }, 60_000);

  it("case 11 UNIT: a delivered unit line is locked with the UNIT sentence, nothing written", async () => {
    const { o, li } = await fixture({ status: "SENT" });
    await raw.orderItem.update({ where: { id: li.id }, data: { unitLabel: "Case" } as any });
    const before = await snapshot(o.id);
    await expect(
      edit(o.id, { replaceAll: false, items: [{ id: li.id, qty: 8 }] }),
    ).rejects.toMatchObject({ status: 409, response: { code: "LINE_ALREADY_DELIVERED" } });
    expect(await snapshot(o.id)).toEqual(before);
  }, 60_000);

  it("case 11 WRITTEN_OFF (operator): an operator edit of the same order is refused too, nothing written", async () => {
    const { o, li } = await fixture({ status: "WRITTEN_OFF" });
    const before = await snapshot(o.id);
    await expect(
      edit(
        o.id,
        { replaceAll: false, items: [{ id: li.id, qty: 8 }] },
        principal("OPERATOR", operatorUserId),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(o.id)).toEqual(before);
  }, 60_000);

  it("case 12a: a stale revision is 409 ORDER_REVISION_STALE and nothing is written", async () => {
    const { o, li } = await fixture({ status: "SENT" });
    const before = await snapshot(o.id);
    await expect(
      edit(o.id, {
        replaceAll: false,
        expectedRevisionNumber: 999,
        items: [{ id: li.id, qty: 8 }],
      }),
    ).rejects.toMatchObject({ status: 409, response: { code: "ORDER_REVISION_STALE" } });
    expect(await snapshot(o.id)).toEqual(before);
  }, 60_000);

  it("a take-off (CANCEL) of the delivered line drops it from the SENT invoice and keeps the status", async () => {
    const { o, li, inv } = await fixture({ status: "SENT" });
    await edit(o.id, { replaceAll: false, items: [{ id: li.id, action: "CANCEL" }] });
    expect((await invoiceOf(inv.id)).status).toBe("SENT");
    expect(await invoiceQty(inv.id)).toBe(0);
    const after = await raw.orderItem.findUniqueOrThrow({ where: { id: li.id } });
    expect(after.status).toBe("CANCELLED");
    expect(Number(after.deliveredQty)).toBe(0);
  }, 60_000);
});
