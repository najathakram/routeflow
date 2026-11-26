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

  it("case 11 UNIT: a delivered unit line stays refused (the unit-aware guard answers first), nothing written", async () => {
    const { o, li } = await fixture({ status: "SENT" });
    await raw.orderItem.update({ where: { id: li.id }, data: { unitLabel: "Case" } as any });
    const before = await snapshot(o.id);
    await expect(
      edit(o.id, { replaceAll: false, items: [{ id: li.id, qty: 8 }] }),
    ).rejects.toMatchObject({ status: 409, response: { code: "UNIT_AWARE_LINE" } });
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

  it("AD-3: taking off the only line of a SENT invoice is a 409 ORDER_EDIT_EMPTIES_INVOICE with 0 writes", async () => {
    const { o, li, inv } = await fixture({ status: "SENT" });
    const before = await snapshot(o.id);
    const invBefore = await invoiceOf(inv.id);
    await expect(
      edit(o.id, { replaceAll: false, items: [{ id: li.id, action: "CANCEL", deliveredTo: 0 }] }),
    ).rejects.toMatchObject({ status: 409, response: { code: "ORDER_EDIT_EMPTIES_INVOICE" } });
    const invAfter = await invoiceOf(inv.id);
    expect(Number(invAfter.total)).toBe(Number(invBefore.total));
    expect(invAfter.status).toBe(invBefore.status);
    expect(await snapshot(o.id)).toEqual(before);
  }, 60_000);

  /** A second delivered line (5 x 10.00, an office row) on the fixture's order, billed on its invoice. */
  async function addSecondLine(fx: Awaited<ReturnType<typeof fixture>>) {
    const p = await raw.product.create({
      data: {
        name: `sa1506r snack ${run} #${productIds.length + 1}`,
        unit: "ea",
        pricePerUnit: "10.00",
        currentStock: "90",
        tenantId,
      },
    });
    productIds.push(p.id);
    const li = await raw.orderItem.create({
      data: {
        orderId: fx.o.id,
        tenantId,
        productId: p.id,
        qty: 5,
        deliveredQty: 5,
        unitPrice: "10.00",
        subtotal: "50.00",
      },
    });
    await raw.deliveryMutation.create({
      data: {
        orderId: fx.o.id,
        orderItemId: li.id,
        productId: p.id,
        routeRunStopId: null,
        driverId: null,
        type: "DELIVERED",
        quantityDelivered: 5,
        note: "OFFICE_MARKED",
        tenantId,
      },
    });
    await raw.invoiceItem.create({
      data: {
        tenantId,
        invoiceId: fx.inv.id,
        orderItemId: li.id,
        productId: p.id,
        description: "snack",
        qty: 5,
        unitPrice: "10.00",
        subtotal: "50.00",
      } as any,
    });
    await raw.invoice.update({
      where: { id: fx.inv.id },
      data: { subtotal: "150.00", total: "150.00" },
    });
    await raw.order.update({
      where: { id: fx.o.id },
      data: { subtotal: "150.00", total: "150.00" },
    });
    return li;
  }
  const stockRows = (productId: string) => raw.stockMovement.count({ where: { productId } });
  const stockOf = async (productId: string) =>
    Number((await raw.product.findUniqueOrThrow({ where: { id: productId } })).currentStock);

  it("SA-1536 (ab): a take-off restates the invoice IN the edit transaction; the post-commit rebuild is not called", async () => {
    const fx = await fixture({ status: "SENT" });
    await addSecondLine(fx);
    const invoices: any = orders.invoicesService;
    const resync = jest.spyOn(invoices, "resyncOrderInvoicesForEdit");
    try {
      await edit(fx.o.id, {
        replaceAll: false,
        items: [{ id: fx.li.id, action: "CANCEL", deliveredTo: 0 }],
      });
      expect(resync).toHaveBeenCalledTimes(1); // wrong value: 2 (one in the tx, one after commit), or 1 post-commit
      expect(resync.mock.calls[0][1]).toBeDefined(); // the edit's own transaction
      expect(resync.mock.calls[0][2]).toBeDefined(); // with its after-commit queue
    } finally {
      resync.mockRestore();
    }
    expect(await invoiceQty(fx.inv.id)).toBe(5); // the taken-off 10 are no longer billed
    expect(Number((await invoiceOf(fx.inv.id)).total)).toBe(50);
    expect(await stockOf(fx.productId)).toBe(100); // the 10 are back on the shelf, in the same commit
  }, 60_000);

  it("SA-1536 (ab): a cut restates in the transaction too (map not empty): one call, with the tx", async () => {
    const fx = await fixture({ status: "SENT" });
    const resync = jest.spyOn(orders.invoicesService as any, "resyncOrderInvoicesForEdit");
    try {
      await edit(fx.o.id, { replaceAll: false, items: [{ id: fx.li.id, qty: 8 }] });
      expect(resync).toHaveBeenCalledTimes(1);
      expect(resync.mock.calls[0][1]).toBeDefined();
    } finally {
      resync.mockRestore();
    }
    expect(await invoiceQty(fx.inv.id)).toBe(8);
    expect(await stockOf(fx.productId)).toBe(92);
  }, 60_000);

  it("SA-1536 (ab) / SA-1544 (aq): a take-off with the rebuild forced to throw writes nothing (0 stock rows, 0 line changes); the error is the thrown one, not a typed 409", async () => {
    const fx = await fixture({ status: "SENT" });
    await addSecondLine(fx);
    const before = await snapshot(fx.o.id);
    const rowsBefore = await stockRows(fx.productId);
    // the judge's projection reads the same invoices before the write; the forced failure is the in-tx rebuild itself
    const rebuild = jest
      .spyOn(orders.invoicesService as any, "resyncOrderInvoicesForEdit")
      .mockRejectedValueOnce(new Error("forced rebuild failure"));
    try {
      await expect(
        edit(fx.o.id, {
          replaceAll: false,
          items: [{ id: fx.li.id, action: "CANCEL", deliveredTo: 0 }],
        }),
      ).rejects.toThrow("forced rebuild failure"); // wrong value: 409 ORDER_INVOICES_NEED_REVIEW (the head's catch-all)
      expect(rebuild).toHaveBeenCalledTimes(1); // an untyped error is never retried, and it aborted
    } finally {
      rebuild.mockRestore();
    }
    expect(await stockRows(fx.productId)).toBe(rowsBefore); // wrong value: +1 (the restock committed alone)
    expect(await stockOf(fx.productId)).toBe(90);
    expect(await snapshot(fx.o.id)).toEqual(before);
  }, 60_000);

  it("SA-1536 (ab): a take-off on an order whose invoice the edit cannot restate (a line added on the invoice itself) is a 409 with 0 moves", async () => {
    const fx = await fixture({ status: "SENT" });
    await addSecondLine(fx);
    await raw.invoiceItem.create({
      data: {
        tenantId,
        invoiceId: fx.inv.id,
        orderItemId: null,
        description: "manual charge",
        qty: 1,
        unitPrice: "5.00",
        subtotal: "5.00",
      } as any,
    });
    const before = await snapshot(fx.o.id);
    const rowsBefore = await stockRows(fx.productId);
    await expect(
      edit(fx.o.id, {
        replaceAll: false,
        items: [{ id: fx.li.id, action: "CANCEL", deliveredTo: 0 }],
      }),
    ).rejects.toMatchObject({ status: 409, response: { code: "ORDER_INVOICES_NEED_REVIEW" } });
    expect(await stockRows(fx.productId)).toBe(rowsBefore);
    expect(await snapshot(fx.o.id)).toEqual(before);
  }, 60_000);

  // SA-1536 (aj): OBSERVE ONLY, no assertion on the outcome. A reopened, partly invoiced order: a no-row 10/12 line billed
  // for 10, cut to 10 by an admin. The lead files the bug row from observe.txt.
  it("SA-1536 (aj) OBSERVE: a reopened, partly invoiced order, a no-row 10/12 line cut to 10 by an admin: stock, column, invoice qty", async () => {
    const fx = await fixture({ status: "SENT", qty: 12, officeRow: false });
    await raw.orderItem.update({
      where: { id: fx.li.id },
      data: { deliveredQty: 10, invoicedQty: 10 } as any,
    });
    await raw.invoiceItem.updateMany({
      where: { invoiceId: fx.inv.id },
      data: { qty: 10, subtotal: "100.00" },
    });
    await raw.invoice.update({
      where: { id: fx.inv.id },
      data: { subtotal: "100.00", total: "100.00" },
    });
    const stockBefore = await stockOf(fx.productId);
    const resync = jest.spyOn(orders.invoicesService as any, "resyncOrderInvoicesForEdit");
    let outcome = "accepted";
    let resyncCalls = 0;
    try {
      await edit(fx.o.id, { replaceAll: false, items: [{ id: fx.li.id, qty: 10 }] });
    } catch (e: any) {
      outcome = "refused " + (e?.response?.code ?? e?.message);
    } finally {
      resyncCalls = resync.mock.calls.length;
      resync.mockRestore();
    }
    const line = await raw.orderItem.findUniqueOrThrow({ where: { id: fx.li.id } });
    require("fs").appendFileSync(
      "C:/ClaudeCode/wt/sa1506-pr1-logs/observe.txt",
      "AJ partly invoiced 10/12 (invoice bills 10) cut to 10 by an admin: " +
        outcome +
        " stockDelta=" +
        ((await stockOf(fx.productId)) - stockBefore) +
        " column=" +
        Number(line.deliveredQty) +
        " qty=" +
        Number(line.qty) +
        " invoicedQty=" +
        Number((line as any).invoicedQty) +
        " invoiceQty=" +
        (await invoiceQty(fx.inv.id)) +
        " invoiceStatus=" +
        (await invoiceOf(fx.inv.id)).status +
        " rebuildCalls=" +
        resyncCalls +
        String.fromCharCode(10),
    );
  }, 60_000);

  // R-265 / H-1 evidence (OBSERVE ONLY, no assertion on the outcomes): which path an admin cut and an admin raise take on a
  // reopened (CONFIRMED) order with a SENT or PAID invoice, with and without a live delivered line. The path is read from which
  // invoice-service functions the edit called, and with what transaction argument.
  it("H-1 OBSERVE: the path of an admin cut and raise on a reopened CONFIRMED order with a SENT / PAID invoice, with and without a delivered line", async () => {
    const invoices: any = orders.invoicesService;
    const names = [
      "resyncOrderInvoicesForEdit",
      "reconcileOrderDraftInvoice",
      "revertLinkedInvoicesForOrderEdit",
    ];
    const lines: string[] = [];
    for (const delivered of [true, false])
      for (const status of ["SENT", "PAID"] as const)
        for (const kind of ["cut", "raise"] as const) {
          const fx = await fixture({
            status,
            paid: status === "PAID" ? 100 : undefined,
            officeRow: delivered,
          });
          if (!delivered)
            await raw.orderItem.update({ where: { id: fx.li.id }, data: { deliveredQty: 0 } });
          const spies = names.map((n) => jest.spyOn(invoices, n));
          let outcome = "accepted";
          try {
            await edit(fx.o.id, {
              replaceAll: false,
              items: [{ id: fx.li.id, qty: kind === "cut" ? 8 : 12 }],
            });
          } catch (e: any) {
            outcome = "refused " + (e?.status ?? "") + " " + (e?.response?.code ?? e?.message);
          }
          const called = spies
            .map((s, i) =>
              s.mock.calls.length
                ? names[i] +
                  "x" +
                  s.mock.calls.length +
                  (i === 0 ? (s.mock.calls[0][1] ? "(in tx)" : "(own tx, after commit)") : "")
                : null,
            )
            .filter(Boolean)
            .join("+");
          spies.forEach((s) => s.mockRestore());
          const inv = await invoiceOf(fx.inv.id);
          const ord = await raw.order.findUniqueOrThrow({ where: { id: fx.o.id } });
          lines.push(
            "H1 delivered=" +
              delivered +
              " invoice=" +
              status +
              " " +
              kind +
              ": " +
              outcome +
              " | called=" +
              (called || "none") +
              " | invoice " +
              status +
              " -> " +
              inv.status +
              " total=" +
              Number(inv.total) +
              " qty=" +
              (await invoiceQty(fx.inv.id)) +
              " | order=" +
              ord.status,
          );
        }
    require("fs").appendFileSync(
      "C:/ClaudeCode/wt/sa1506-pr1-logs/observe.txt",
      lines.join(String.fromCharCode(10)) + String.fromCharCode(10),
    );
  }, 120_000);

  // ---------------------------------------------------------------------------------------------------------------
  // SA-1544 (Amendment 9): (ap) (aq) (ar) (at) (au) (av), real Postgres, real InvoicesService.
  // ---------------------------------------------------------------------------------------------------------------

  /** An undelivered second line (qty 5 x 10.00, deliveredQty 0) billed on the fixture's invoice (office-invoiced). */
  async function addUndeliveredLine(fx: Awaited<ReturnType<typeof fixture>>, billed = true) {
    const p = await raw.product.create({
      data: {
        name: `sa1506r chips ${run} #${productIds.length + 1}`,
        unit: "ea",
        pricePerUnit: "10.00",
        currentStock: "90",
        tenantId,
      },
    });
    productIds.push(p.id);
    const li = await raw.orderItem.create({
      data: {
        orderId: fx.o.id,
        tenantId,
        productId: p.id,
        qty: 5,
        deliveredQty: 0,
        unitPrice: "10.00",
        subtotal: "50.00",
      },
    });
    if (billed) {
      await raw.invoiceItem.create({
        data: {
          tenantId,
          invoiceId: fx.inv.id,
          orderItemId: li.id,
          productId: p.id,
          description: "chips",
          qty: 5,
          unitPrice: "10.00",
          subtotal: "50.00",
        } as any,
      });
      await raw.invoice.update({
        where: { id: fx.inv.id },
        data: { subtotal: "150.00", total: "150.00" },
      });
    }
    await raw.order.update({
      where: { id: fx.o.id },
      data: { subtotal: "150.00", total: "150.00" },
    });
    return li;
  }
  const paymentRows = (invoiceId: string) =>
    raw.invoicePayment.findMany({
      where: { invoiceId },
      orderBy: { id: "asc" },
      select: { id: true, amount: true, status: true },
    });
  const observeLine = (text: string) =>
    require("fs").appendFileSync(
      "C:/ClaudeCode/wt/sa1506-pr1-logs/observe.txt",
      text + String.fromCharCode(10),
    );

  it("SA-1544 (as) OBSERVE: one timed run of the correction path (a take-off restated in the tx, a SENT invoice, 2 lines)", async () => {
    const fx = await fixture({ status: "SENT" });
    await addSecondLine(fx);
    const t0 = Date.now();
    await edit(fx.o.id, {
      replaceAll: false,
      items: [{ id: fx.li.id, action: "CANCEL", deliveredTo: 0 }],
    });
    const ms = Date.now() - t0;
    observeLine(
      "AS timed correction (take-off, restated in tx, 2 lines, SENT): " +
        ms +
        " ms, budget " +
        20_000 +
        " ms",
    );
    expect(ms).toBeLessThan(20_000);
  }, 60_000);

  it("SA-1544 (ap): an OPERATOR edit whose held lines lose their last delivered line between the pre-read and the lock is 409 ORDER_CHANGED_DURING_EDIT, 0 writes", async () => {
    const fx = await fixture({ status: "SENT" });
    const second = await addUndeliveredLine(fx);
    const authGuard = orders.authGuard;
    const rowsBefore = await stockRows(second.productId!);
    // the pre-transaction read has happened (the order holds a delivered line); a staffer zeroes it before the edit's lock
    orders.authGuard = {
      assertAuthorizedOrThrow: async () => {
        await raw.orderItem.update({ where: { id: fx.li.id }, data: { deliveredQty: 0 } });
      },
    };
    try {
      await expect(
        edit(
          fx.o.id,
          { replaceAll: false, items: [{ id: second.id, qty: 6 }] },
          principal("OPERATOR", operatorUserId),
        ),
      ).rejects.toMatchObject({ status: 409, response: { code: "ORDER_CHANGED_DURING_EDIT" } }); // wrong value: accepted
    } finally {
      orders.authGuard = authGuard;
    }
    expect(Number((await raw.orderItem.findUniqueOrThrow({ where: { id: second.id } })).qty)).toBe(
      5,
    );
    expect(Number((await invoiceOf(fx.inv.id)).total)).toBe(150);
    expect((await invoiceOf(fx.inv.id)).status).toBe("SENT");
    expect(await stockRows(second.productId!)).toBe(rowsBefore);
  }, 60_000);

  it("SA-1544 (ap): the same race for an ADMIN edit of another line is refused the same way (every role, one helper)", async () => {
    const fx = await fixture({ status: "SENT" });
    const second = await addUndeliveredLine(fx);
    const authGuard = orders.authGuard;
    orders.authGuard = {
      assertAuthorizedOrThrow: async () => {
        await raw.orderItem.update({ where: { id: fx.li.id }, data: { deliveredQty: 0 } });
      },
    };
    try {
      await expect(
        edit(fx.o.id, { replaceAll: false, items: [{ id: second.id, qty: 6 }] }),
      ).rejects.toMatchObject({ status: 409, response: { code: "ORDER_CHANGED_DURING_EDIT" } });
    } finally {
      orders.authGuard = authGuard;
    }
    expect(Number((await raw.orderItem.findUniqueOrThrow({ where: { id: second.id } })).qty)).toBe(
      5,
    );
  }, 60_000);

  it("SA-1544 (aq): a P2034-shaped error from the in-tx restate is retried (2 or more attempts), then 503 LOCK_UNAVAILABLE, 0 writes", async () => {
    const fx = await fixture({ status: "SENT" });
    await addSecondLine(fx);
    const before = await snapshot(fx.o.id);
    const rowsBefore = await stockRows(fx.productId);
    const conflict = Object.assign(new Error("Transaction failed due to a write conflict"), {
      code: "P2034",
    });
    const rebuild = jest
      .spyOn(orders.invoicesService as any, "resyncOrderInvoicesForEdit")
      .mockRejectedValue(conflict);
    try {
      await expect(
        edit(fx.o.id, {
          replaceAll: false,
          items: [{ id: fx.li.id, action: "CANCEL", deliveredTo: 0 }],
        }),
      ).rejects.toMatchObject({ status: 503, response: { code: "LOCK_UNAVAILABLE" } }); // wrong value: 409 NEED_REVIEW
      expect(rebuild.mock.calls.length).toBeGreaterThanOrEqual(2); // wrong value: 1 (the catch-all hid it from the retry loop)
    } finally {
      rebuild.mockRestore();
    }
    expect(await stockRows(fx.productId)).toBe(rowsBefore);
    expect(await snapshot(fx.o.id)).toEqual(before);
  }, 60_000);

  it("SA-1544 (aq): the restate answering null with a SENT invoice is 409 ORDER_INVOICES_NEED_REVIEW, 0 writes", async () => {
    const fx = await fixture({ status: "SENT" });
    await addSecondLine(fx);
    const before = await snapshot(fx.o.id);
    const rebuild = jest
      .spyOn(orders.invoicesService as any, "resyncOrderInvoicesForEdit")
      .mockResolvedValue(null);
    try {
      await expect(
        edit(fx.o.id, {
          replaceAll: false,
          items: [{ id: fx.li.id, action: "CANCEL", deliveredTo: 0 }],
        }),
      ).rejects.toMatchObject({ status: 409, response: { code: "ORDER_INVOICES_NEED_REVIEW" } });
    } finally {
      rebuild.mockRestore();
    }
    expect(await snapshot(fx.o.id)).toEqual(before);
  }, 60_000);

  it("SA-1544 (aq): an order with no invoice is accepted, and nothing is restated in the transaction", async () => {
    const fx = await fixture({ status: "SENT" });
    await raw.invoiceItem.deleteMany({ where: { invoiceId: fx.inv.id } });
    await raw.invoice.delete({ where: { id: fx.inv.id } });
    const resync = jest.spyOn(orders.invoicesService as any, "resyncOrderInvoicesForEdit");
    try {
      await edit(fx.o.id, { replaceAll: false, items: [{ id: fx.li.id, qty: 8 }] });
      // the post-commit tail still asks the writer once (no tx, nothing to restate); none runs inside the edit
      expect(resync.mock.calls.filter((c) => c[1] !== undefined)).toHaveLength(0);
    } finally {
      resync.mockRestore();
    }
    expect(Number((await raw.orderItem.findUniqueOrThrow({ where: { id: fx.li.id } })).qty)).toBe(
      8,
    );
    expect(await stockOf(fx.productId)).toBe(92);
  }, 60_000);

  it("SA-1544 (ar): a restated staff correction calls followPartialPrices 0 times and the post-commit resync 0 times (one resync, in the tx)", async () => {
    const fx = await fixture({ status: "SENT" });
    const invoices: any = orders.invoicesService;
    const resync = jest.spyOn(invoices, "resyncOrderInvoicesForEdit");
    const follow = jest.spyOn(invoices, "followPartialPrices");
    try {
      await edit(fx.o.id, { replaceAll: false, items: [{ id: fx.li.id, qty: 8 }] });
      expect(follow).toHaveBeenCalledTimes(0); // wrong value: 1
      expect(resync).toHaveBeenCalledTimes(1);
      expect(resync.mock.calls[0][1]).toBeDefined(); // the one call is the in-tx one: wrong value: a second, after commit
    } finally {
      resync.mockRestore();
      follow.mockRestore();
    }
    expect(await invoiceQty(fx.inv.id)).toBe(8);
  }, 60_000);

  it("SA-1544 (at): an ADMIN raise 10 -> 12 on a PAID invoice of a reopened order holding a delivered line is accepted, payments unchanged", async () => {
    const fx = await fixture({ status: "PAID", paid: 100 });
    const paymentsBefore = await paymentRows(fx.inv.id);
    await edit(fx.o.id, { replaceAll: false, items: [{ id: fx.li.id, qty: 12 }] });
    expect(await paymentRows(fx.inv.id)).toEqual(paymentsBefore); // wrong value: refused 400 ORDER_EDIT_INVOICE_HAS_PAYMENTS
    const inv = await invoiceOf(fx.inv.id);
    expect(Number(inv.total)).toBe(120);
    expect(await invoiceQty(fx.inv.id)).toBe(12);
    expect(inv.status).not.toBe("DRAFT"); // never reverted
    expect((await raw.order.findUniqueOrThrow({ where: { id: fx.o.id } })).status).toBe(
      "CONFIRMED",
    );
    observeLine(
      "AT admin raise 10->12 on PAID(100): invoice " +
        inv.status +
        " total=" +
        Number(inv.total) +
        " payments=" +
        paymentsBefore.length,
    );
  }, 60_000);

  it("SA-1544 (at): an OPERATOR raise of an undelivered line on a PAID invoice of the same order is accepted too (B4, red 7b), payments unchanged", async () => {
    const fx = await fixture({ status: "PAID", paid: 100 });
    const second = await addUndeliveredLine(fx);
    const paymentsBefore = await paymentRows(fx.inv.id);
    await edit(
      fx.o.id,
      { replaceAll: false, items: [{ id: second.id, qty: 6 }] },
      principal("OPERATOR", operatorUserId),
    );
    expect(await paymentRows(fx.inv.id)).toEqual(paymentsBefore); // wrong value: 400 ORDER_EDIT_INVOICE_HAS_PAYMENTS
    expect(Number((await raw.orderItem.findUniqueOrThrow({ where: { id: second.id } })).qty)).toBe(
      6,
    );
    expect((await invoiceOf(fx.inv.id)).status).not.toBe("DRAFT");
  }, 60_000);

  it("SA-1544 (at): an OPERATOR raise of the DELIVERED line itself on a PAID invoice is accepted (9.2 row: any other edit), payments unchanged", async () => {
    const fx = await fixture({ status: "PAID", paid: 100 });
    const paymentsBefore = await paymentRows(fx.inv.id);
    let outcome = "accepted";
    try {
      await edit(
        fx.o.id,
        { replaceAll: false, items: [{ id: fx.li.id, qty: 12 }] },
        principal("OPERATOR", operatorUserId),
      );
    } catch (e: any) {
      outcome = "refused " + (e?.status ?? "") + " " + (e?.response?.code ?? e?.message);
    }
    const inv = await invoiceOf(fx.inv.id);
    observeLine(
      "AT operator raise of the delivered line 10->12 on PAID: " +
        outcome +
        "; invoice " +
        inv.status +
        " total=" +
        Number(inv.total),
    );
    expect(outcome).toBe("accepted"); // wrong value: refused (the role lock is for cuts and deletes, never a raise)
    expect(await paymentRows(fx.inv.id)).toEqual(paymentsBefore);
  }, 60_000);

  it("SA-1544 (at): a cut below what was paid stays 409 ORDER_EDIT_WOULD_OVERPAY for an admin AND for the operator's own edit of the undelivered line (case 8 kept)", async () => {
    const fx = await fixture({ status: "PAID", paid: 100 });
    const before = await snapshot(fx.o.id);
    await expect(
      edit(fx.o.id, { replaceAll: false, items: [{ id: fx.li.id, qty: 8 }] }),
    ).rejects.toMatchObject({ status: 409, response: { code: "ORDER_EDIT_WOULD_OVERPAY" } });
    expect(await snapshot(fx.o.id)).toEqual(before);
  }, 60_000);

  it("SA-1544 (au) 9.2 rows 'hold none': PAID / PARTIAL refuse 400 ORDER_EDIT_INVOICE_HAS_PAYMENTS, SENT refuses 409 ORDER_EDIT_REVERTS_SENT_INVOICE without the ack; every staff role, cut and raise, 0 writes", async () => {
    for (const status of ["PAID", "SENT"] as const)
      for (const [who, label] of [
        [principal("TENANT_ADMIN", adminUserId), "admin"],
        [principal("OPERATOR", operatorUserId), "operator"],
      ] as const)
        for (const qty of [8, 12]) {
          const fx = await fixture({
            status,
            paid: status === "PAID" ? 100 : undefined,
            officeRow: false,
          });
          await raw.orderItem.update({ where: { id: fx.li.id }, data: { deliveredQty: 0 } });
          const before = await snapshot(fx.o.id);
          await expect(
            edit(fx.o.id, { replaceAll: false, items: [{ id: fx.li.id, qty }] }, who),
          ).rejects.toMatchObject(
            status === "PAID"
              ? { status: 400, response: { code: "ORDER_EDIT_INVOICE_HAS_PAYMENTS" } }
              : { status: 409, response: { code: "ORDER_EDIT_REVERTS_SENT_INVOICE" } },
          );
          expect([status, label, qty, (await snapshot(fx.o.id)).invoices]).toEqual([
            status,
            label,
            qty,
            before.invoices,
          ]);
        }
  }, 120_000);

  it("SA-1544 (au) 9.2 rows 'hold a live delivered line': SENT is restated and stays SENT for a cut and a raise; WRITTEN_OFF refuses in the tx", async () => {
    for (const [qty, total] of [
      [8, 80],
      [12, 120],
    ] as const) {
      const fx = await fixture({ status: "SENT" });
      await edit(fx.o.id, { replaceAll: false, items: [{ id: fx.li.id, qty }] });
      const inv = await invoiceOf(fx.inv.id);
      expect([qty, inv.status, Number(inv.total)]).toEqual([qty, "SENT", total]);
    }
    const fx = await fixture({ status: "WRITTEN_OFF" });
    await expect(
      edit(fx.o.id, { replaceAll: false, items: [{ id: fx.li.id, qty: 12 }] }),
    ).rejects.toMatchObject({ status: 409 });
  }, 120_000);

  it("SA-1544 (av): after a take-off removes the last live delivered line the next edit takes the undelivered path: an OPERATOR edit of a SENT invoice is 409 ORDER_EDIT_REVERTS_SENT_INVOICE", async () => {
    const fx = await fixture({ status: "SENT" });
    const second = await addUndeliveredLine(fx);
    await edit(fx.o.id, {
      replaceAll: false,
      items: [{ id: fx.li.id, action: "CANCEL", deliveredTo: 0 }],
    }); // accepted and restated: the invoice keeps only the undelivered line
    expect(Number((await invoiceOf(fx.inv.id)).total)).toBe(50);
    // the entry condition of the flip: nothing live is delivered any more
    const held = await raw.orderItem.findMany({ where: { orderId: fx.o.id } });
    expect(held.some((l) => l.status !== "CANCELLED" && Number(l.deliveredQty) > 0)).toBe(false);
    const before = await snapshot(fx.o.id);
    await expect(
      edit(
        fx.o.id,
        { replaceAll: false, items: [{ id: second.id, qty: 6 }] },
        principal("OPERATOR", operatorUserId),
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: "ORDER_EDIT_REVERTS_SENT_INVOICE" } }); // wrong value: accepted in place
    expect((await snapshot(fx.o.id)).invoices).toEqual(before.invoices);
  }, 60_000);

  it("SA-1544 (av): the same flip on an invoice with a payment is 400 ORDER_EDIT_INVOICE_HAS_PAYMENTS", async () => {
    const fx = await fixture({ status: "SENT" });
    const second = await addUndeliveredLine(fx);
    await raw.invoicePayment.create({
      data: {
        tenantId,
        invoiceId: fx.inv.id,
        amount: "50.00",
        method: "CASH",
        status: "PAID",
      } as any,
    });
    await raw.invoice.update({ where: { id: fx.inv.id }, data: { status: "PARTIAL" } });
    await edit(fx.o.id, {
      replaceAll: false,
      items: [{ id: fx.li.id, action: "CANCEL", deliveredTo: 0 }],
    });
    const held = await raw.orderItem.findMany({ where: { orderId: fx.o.id } });
    expect(held.some((l) => l.status !== "CANCELLED" && Number(l.deliveredQty) > 0)).toBe(false);
    const paymentsBefore = await paymentRows(fx.inv.id);
    await expect(
      edit(
        fx.o.id,
        { replaceAll: false, items: [{ id: second.id, qty: 6 }] },
        principal("OPERATOR", operatorUserId),
      ),
    ).rejects.toMatchObject({ status: 400, response: { code: "ORDER_EDIT_INVOICE_HAS_PAYMENTS" } }); // wrong value: accepted in place
    expect(await paymentRows(fx.inv.id)).toEqual(paymentsBefore);
  }, 60_000);
});
