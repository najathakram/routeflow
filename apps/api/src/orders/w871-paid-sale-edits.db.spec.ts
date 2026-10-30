/**
 * W-861 + W-871 (SA-944 §3, SA-948 §2) on real Postgres: every new query runs against the real schema.
 *  - A paid walk-in sale (DELIVERED, PAID invoice, a PAID CASH payment): adding a line through the REAL
 *    OrdersService.updateOrderItems is 409 WALK_IN_SALE_PAID and the order, its lines and its invoice are unchanged;
 *    `walkInSaleLocked` reads the live payment through the InvoicePayment -> Invoice relation, and a VOID payment
 *    unlocks it.
 *  - A named customer's paid DELIVERED sale: a staff replace-all is 409 LINES_REPLACE_AFTER_DELIVERY, nothing written.
 *  - `POST /invoices/:id/reopen`'s guard refuses the walk-in sale's PAID invoice.
 *  - The overpay judge's fail-closed fallback, on a real transaction: the projection stub returns nothing (what the
 *    re-sync returns on an unclean partition), the stored external money (2.00) exceeds the order total (1.50): 409.
 *
 * Builds a REAL OrdersService via `Object.create` (no Nest DI), as b1234-delivered-line-lock.db.spec.ts does.
 * NOT RUN by the lane that wrote it; the DB lane runs it (`npm run local:test:db`).
 *
 * SAFETY: one throwaway `qa-w871-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes exactly the rows
 * this run created.
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
import { prismaQueryable, waitUntilBlocked } from "../common/testing/blocked-wait";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "./orders.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { INVOICE_EDIT_STUBS } from "./testing/invoice-edit-stubs";
import { walkInSaleLocked } from "./counter-sale/walk-in-sale-lock";
import { assertEditCannotOverpay } from "./edit-overpay-judge";
import { loadReopenableInvoice } from "../invoices/invoice-reopen-guard";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("W-861 + W-871 — paid walk-in edits and post-delivery replaces, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-w871-${run}`, "w871-paid-sale-edits.db.spec.ts");
  let tenantId = "";
  let operatorUserId = "";
  const userIds: string[] = [];
  const customerIds: string[] = [];
  const productIds: string[] = [];
  const orderIds: string[] = [];
  const invoiceIds: string[] = [];

  const operator = (): JwtPayload =>
    ({
      sub: operatorUserId,
      username: `operator-${run}`,
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    }) as JwtPayload;

  async function customer(isWalkIn: boolean) {
    const u = await raw.user.create({
      data: {
        email: `c-${customerIds.length}-${run}@example.test`,
        username: `c-${customerIds.length}-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    userIds.push(u.id);
    const c = await raw.customer.create({
      data: {
        userId: u.id,
        businessName: isWalkIn ? "Walk-in" : "Acme Retail",
        contactName: "Tester",
        tenantId,
        isWalkIn,
      },
    });
    customerIds.push(c.id);
    return c.id;
  }

  async function product() {
    const p = await raw.product.create({
      data: {
        name: `w871 cola ${run} #${productIds.length + 1}`,
        unit: "ea",
        pricePerUnit: "1.00",
        currentStock: "90",
        tenantId,
      },
    });
    productIds.push(p.id);
    return p.id;
  }

  /** A DELIVERED sale of 2 x 1.00, billed by a PAID invoice paid 2.00 in CASH (`paid: false`: a SENT invoice, no payment). */
  async function paidSale(customerId: string, opts: { paid?: boolean } = {}) {
    const paid = opts.paid !== false;
    const productId = await product();
    const o = await raw.order.create({
      data: {
        customerId,
        tenantId,
        status: "DELIVERED",
        subtotal: "2.00",
        total: "2.00",
        lineItems: {
          create: [
            {
              tenantId,
              productId,
              qty: 2,
              deliveredQty: 2,
              invoicedQty: 2,
              unitPrice: "1.00",
              subtotal: "2.00",
            },
          ],
        },
      },
      include: { lineItems: true },
    });
    orderIds.push(o.id);
    const inv = await raw.invoice.create({
      data: {
        tenantId,
        customerId,
        orderId: o.id,
        invoiceNumber: `INV-${randomUUID().slice(0, 8)}`,
        status: paid ? "PAID" : "SENT",
        subtotal: "2.00",
        total: "2.00",
        items: {
          create: [
            {
              tenantId,
              orderItemId: o.lineItems[0].id,
              productId,
              description: "cola",
              qty: 2,
              unitPrice: "1.00",
              subtotal: "2.00",
            } as any,
          ],
        },
      },
    });
    invoiceIds.push(inv.id);
    const pay = paid
      ? await raw.invoicePayment.create({
          data: {
            tenantId,
            invoiceId: inv.id,
            amount: "2.00",
            method: "CASH",
            status: "PAID",
          } as any,
        })
      : (undefined as never);
    return { o, inv, pay, productId };
  }

  /**
   * What `InvoicesService.writeInvoicePayment` holds while it records a payment: the INVOICE row FOR UPDATE (never the
   * Order row), the payment insert, the invoice status write, all uncommitted until `release()`.
   */
  async function openPayment(invoiceId: string, amount: string) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const ready = new Promise<void>((r) => (held = r));
    const done = raw.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${invoiceId} FOR UPDATE`;
        await tx.invoicePayment.create({
          data: { tenantId, invoiceId, amount, method: "CASH", status: "PAID" } as never,
        });
        await tx.invoice.update({ where: { id: invoiceId }, data: { status: "PAID" } });
        held();
        await gate;
      },
      { timeout: 30_000 },
    );
    done.catch(() => held()); // a failed open must not hang the test on `ready`
    await ready;
    return { release, done };
  }

  const snapshot = async (orderId: string) => ({
    header: await raw.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { subtotal: true, total: true, status: true },
    }),
    lines: await raw.orderItem.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } }),
    invoices: await raw.invoice.findMany({
      where: { orderId },
      orderBy: { id: "asc" },
      select: { id: true, status: true, subtotal: true, total: true },
    }),
  });
  const edit = (orderId: string, dto: any) =>
    tenantCtx.run(tenantId, () => orders.updateOrderItems(orderId, dto, operator()));

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
    tenantId = (await raw.tenant.create({ data: { slug, name: `w871 ${slug}` } })).id;
    operatorUserId = (
      await raw.user.create({
        data: { email: `o-${run}@example.test`, username: `o-${run}`, role: "OPERATOR", tenantId },
      })
    ).id;
    userIds.push(operatorUserId);
  }, 120_000);

  afterAll(async () => {
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

  it("W-861: adding a line to a paid walk-in sale is 409 WALK_IN_SALE_PAID, nothing written (master: 2.16-class balance)", async () => {
    const { o } = await paidSale(await customer(true));
    const before = await snapshot(o.id);
    const newProduct = await product();
    await expect(
      edit(o.id, { items: [{ productId: newProduct, action: "ADD", qty: 1 }] }),
    ).rejects.toMatchObject({ status: 409, response: { code: "WALK_IN_SALE_PAID" } });
    expect(await snapshot(o.id)).toEqual(before);
  });

  it("walkInSaleLocked reads the live payment through the real relation; a VOID payment unlocks it", async () => {
    const walkInId = await customer(true);
    const { o, pay } = await paidSale(walkInId);
    const read = () =>
      tenantCtx.run(tenantId, () =>
        walkInSaleLocked(prisma.forTenant() as any, { id: o.id, customer: { isWalkIn: true } }),
      );
    expect(await read()).toBe(true);
    await raw.invoicePayment.update({ where: { id: pay.id }, data: { status: "VOID" } });
    expect(await read()).toBe(false);
  });

  it("the order read sends editItemsLocked", async () => {
    const { o } = await paidSale(await customer(true));
    const read = await tenantCtx.run(tenantId, () => orders.findOne(o.id, operator()));
    expect(read.editItemsLocked).toBe(true);
  });

  it("W-871: a staff replace-all on a named customer's paid DELIVERED sale is 409, nothing written", async () => {
    const { o, productId } = await paidSale(await customer(false));
    const before = await snapshot(o.id);
    await expect(
      edit(o.id, { replaceAll: true, items: [{ productId, qty: 1 }] }),
    ).rejects.toMatchObject({ status: 409, response: { code: "LINES_REPLACE_AFTER_DELIVERY" } });
    expect(await snapshot(o.id)).toEqual(before);
  });

  it("the reopen guard refuses the walk-in sale's PAID invoice and passes a named one", async () => {
    const walkIn = await paidSale(await customer(true));
    const named = await paidSale(await customer(false));
    const load = (id: string) =>
      tenantCtx.run(tenantId, () => loadReopenableInvoice(prisma.forTenant(), id));
    await expect(load(walkIn.inv.id)).rejects.toMatchObject({
      status: 409,
      response: { code: "WALK_IN_SALE_PAID" },
    });
    await expect(load(named.inv.id)).resolves.toMatchObject({ id: named.inv.id });
  });

  it("SA-956 (a): a qty increase on a paid named sale whose invoice holds a manual line is 200, not 409 (head: 409)", async () => {
    const { o, inv, pay, productId: pid } = await paidSale(await customer(false));
    // an invoice-only 3.00 manual line, paid in full: invoice 5.00, CASH 5.00, while the order total is 2.00
    await raw.invoiceItem.create({
      data: {
        tenantId,
        invoiceId: inv.id,
        description: "manual charge",
        qty: 1,
        unitPrice: "3.00",
        subtotal: "3.00",
      } as never,
    });
    await raw.invoice.update({ where: { id: inv.id }, data: { subtotal: "5.00", total: "5.00" } });
    await raw.invoicePayment.update({ where: { id: pay.id }, data: { amount: "5.00" } });
    await edit(o.id, {
      items: [{ id: o.lineItems[0].id, productId: pid, qty: 3 }],
      replaceAll: false,
    });
    const after = await raw.order.findUniqueOrThrow({
      where: { id: o.id },
      select: { total: true },
    });
    expect(Number(after.total)).toBe(3);
  });

  it("SA-956 (c): a cut on that same order is still 409, with nothing written", async () => {
    const { o, inv, pay, productId: pid } = await paidSale(await customer(false));
    await raw.invoiceItem.create({
      data: {
        tenantId,
        invoiceId: inv.id,
        description: "manual charge",
        qty: 1,
        unitPrice: "3.00",
        subtotal: "3.00",
      } as never,
    });
    await raw.invoice.update({ where: { id: inv.id }, data: { subtotal: "5.00", total: "5.00" } });
    await raw.invoicePayment.update({ where: { id: pay.id }, data: { amount: "5.00" } });
    const before = await snapshot(o.id);
    await expect(
      edit(o.id, { items: [{ id: o.lineItems[0].id, productId: pid, qty: 1 }], replaceAll: false }),
    ).rejects.toMatchObject({ status: 409, response: { code: "ORDER_EDIT_WOULD_OVERPAY" } });
    expect(await snapshot(o.id)).toEqual(before);
  });

  it("review-a read 1: a payment recording while the edit locks the Order cannot slip past the paid walk-in recheck", async () => {
    // An UNPAID walk-in sale: `editGuards` (no tx, no lock) sees nothing paid, so the edit tx opens. The office's
    // Record payment is mid-flight: it holds the INVOICE row and an uncommitted PAID payment, and takes no Order lock.
    const { o, inv, productId: pid } = await paidSale(await customer(true), { paid: false });
    const payment = await openPayment(inv.id, "2.00");
    const editing = edit(o.id, {
      items: [{ id: o.lineItems[0].id, productId: pid, qty: 3 }],
      replaceAll: false,
    }).then(
      () => "edited",
      (e: any) => e,
    );
    let settled = false;
    void editing.then(() => (settled = true));
    const blocked = await waitUntilBlocked(prismaQueryable(raw), { until: () => settled });
    payment.release();
    await payment.done;
    const outcome = await editing;
    const after = await snapshot(o.id);
    // The wrong value the unfixed recheck leaves behind: order total 3.00 over a walk-in sale already paid 2.00.
    expect(Number(after.header.total)).toBe(2);
    expect(after.lines.map((l) => Number(l.qty))).toEqual([2]);
    expect(outcome).toMatchObject({ status: 409, response: { code: "WALK_IN_SALE_PAID" } });
    expect(blocked.length).toBeGreaterThan(0); // the edit WAITED behind the payment, it did not race past it
  }, 60_000);

  it("the judge fails closed on a real tx: 2.00 paid over a 1.50 order total the re-sync cannot project is 409", async () => {
    const { o, inv } = await paidSale(await customer(false));
    await raw.order.update({ where: { id: o.id }, data: { subtotal: "1.50", total: "1.50" } });
    await expect(
      tenantCtx.run(tenantId, () =>
        prisma.tenantTransaction((tx: any) =>
          assertEditCannotOverpay(
            { invoices: { projectEditedInvoiceTotals: async () => [] }, tenantId },
            tx,
            o.id,
            { resync: true, partials: false, priorOrderTotal: 2 }, // a cut: the seeded order total was 2.00
          ),
        ),
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        code: "ORDER_EDIT_WOULD_OVERPAY",
        invoiceId: inv.id,
        paid: 2,
        projectedTotal: 1.5,
        excess: 0.5,
      },
    });
  });
});
