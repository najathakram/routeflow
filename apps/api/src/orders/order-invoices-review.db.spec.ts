/**
 * B1116, real Postgres: the staff order detail's `invoicesNeedReview` runs the real query end to end
 * — the real `findOne` read, #3216's derived predicate over real Invoice / InvoiceItem / OrderItem
 * rows, and the optional "flagged at a stop" lookup (the AuditLog read and the User -> Driver relation
 * select, which a mock would accept even if the relation did not exist).
 *
 *   - an order whose invoice carries an orphaned product line beside a live remainder -> flagged;
 *   - an order whose invoices are in step, a VOID-only order, and an order with no invoice -> not;
 *   - a counter that disagrees with what the invoices bill, with nothing left to bill -> flagged;
 *   - a stop-completion ORDER_INVOICES_NEED_REVIEW audit row names the driver; a NEWER row for the
 *     same entity id in ANOTHER tenant never does, nor a newer row of another context; and an audit
 *     row alone never flags an order;
 *   - a buyer (CUSTOMER) read of a flagged order carries no field and never calls the predicate;
 *   - the other tenant's flagged order is simply not found from this tenant.
 *
 * Runs only under the DB lane (jest.db.config.js collects `*.db.spec.ts`; RUN_DB_SPECS set,
 * DATABASE_URL pointed at a local Postgres). Tenants are throwaway `qa-1116-<run>-<n>` slugs approved
 * by `assertTestTenant`; `afterAll` deletes what they hold. Scaffold: split-invoice-no-rebuild-sa681.db.spec.ts.
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import * as partition from "../invoices/invoice-partition";
import { ORDER_INVOICES_NEED_REVIEW_MESSAGE } from "../invoices/invoice-partition";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { OrdersService } from "./orders.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(): string {
  tenantSeq += 1;
  return assertTestTenant(`qa-1116-${RUN_SUFFIX}-${tenantSeq}`, "order-invoices-review.db.spec.ts");
}

describeDb("staff order detail: invoicesNeedReview over real rows (B1116)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: OrdersService;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    service = Object.assign(Object.create(OrdersService.prototype), { prisma }) as OrdersService;
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      const where = { tenantId };
      await (async () => {
        await prisma.auditLog.deleteMany({ where });
        await prisma.invoiceItem.deleteMany({ where });
        await prisma.invoice.deleteMany({ where });
        await prisma.orderItem.deleteMany({ where: { order: { tenantId } } });
        await prisma.order.deleteMany({ where });
        await prisma.product.deleteMany({ where });
        await prisma.customer.deleteMany({ where });
        await prisma.driver.deleteMany({ where });
        await prisma.user.deleteMany({ where });
        await prisma.tenant.deleteMany({ where: { id: tenantId } });
      })().catch(() => undefined);
    }
    await prisma?.$disconnect();
  });

  async function seedTenant() {
    const slug = freshTenantSlug();
    const tenant = await prisma.tenant.create({ data: { slug, name: `1116 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const buyerUser = await prisma.user.create({
      data: {
        email: `buyer-${slug}@example.invalid`,
        username: `buyer-${slug}`,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: buyerUser.id,
        businessName: "1116",
        contactName: "1116",
        tenantId: tenant.id,
      } as any,
    });
    const driverUser = await prisma.user.create({
      data: {
        email: `driver-${slug}@example.invalid`,
        username: `driver-${slug}`,
        role: "DRIVER",
        tenantId: tenant.id,
      },
    });
    await prisma.driver.create({
      data: { userId: driverUser.id, contactName: "Dana Driver", tenantId: tenant.id } as any,
    });
    const product = await prisma.product.create({
      data: { name: `1116 ${slug}`, unit: "ea", pricePerUnit: 2, tenantId: tenant.id } as any,
    });
    let orderSeq = 0;
    /** One CONFIRMED order with one line (qty 10, `invoicedQty` as given). */
    const order = async (invoicedQty: number) => {
      orderSeq += 1;
      const o = await prisma.order.create({
        data: {
          tenantId: tenant.id,
          customerId: customer.id,
          orderNumber: `ORD-1116-${slug}-${orderSeq}`,
          status: "CONFIRMED",
          subtotal: 20,
          tax: 0,
          total: 20,
        } as any,
      });
      const line = await prisma.orderItem.create({
        data: {
          orderId: o.id,
          productId: product.id,
          qty: 10,
          invoicedQty,
          unitPrice: 2,
          subtotal: 20,
          status: "CONFIRMED",
          tenantId: tenant.id,
        } as any,
      });
      return { orderId: o.id, lineId: line.id };
    };
    let invSeq = 0;
    /** A non-void (or VOID) invoice on the order carrying one product line of `qty`. */
    const invoice = async (
      orderId: string,
      item: { orderItemId: string | null; qty: number },
      status: "DRAFT" | "VOID" = "DRAFT",
    ) => {
      invSeq += 1;
      const inv = await prisma.invoice.create({
        data: {
          tenantId: tenant.id,
          customerId: customer.id,
          orderId,
          invoiceNumber: `INV-1116-${slug}-${invSeq}`,
          status,
          subtotal: item.qty * 2,
          taxAmount: 0,
          total: item.qty * 2,
        } as any,
      });
      await prisma.invoiceItem.create({
        data: {
          invoiceId: inv.id,
          tenantId: tenant.id,
          productId: product.id,
          orderItemId: item.orderItemId,
          description: "1116 line",
          qty: item.qty,
          unitPrice: 2,
          subtotal: item.qty * 2,
        } as any,
      });
      return inv.id;
    };
    const audit = (
      orderId: string,
      userId: string | null,
      at: string,
      forTenantId = tenant.id,
      context = "stop-completion",
    ) =>
      prisma.auditLog.create({
        data: {
          tenantId: forTenantId,
          userId,
          action: "ORDER_INVOICES_NEED_REVIEW",
          entityType: "order",
          entityId: orderId,
          meta: { context },
          createdAt: new Date(at),
        },
      });
    return {
      tenantId: tenant.id,
      customerUserId: buyerUser.id,
      driverUserId: driverUser.id,
      order,
      invoice,
      audit,
    };
  }

  const staff = (tenantId: string, role: "OPERATOR" | "TENANT_ADMIN" = "OPERATOR") =>
    ({ sub: randomUUID(), username: "staff", role, tenantId, tenantSlug: "x" }) as never;
  const read = (tenantId: string, orderId: string, who: never) =>
    tenantCtx.run(tenantId, () => service.findOne(orderId, who)) as Promise<any>;

  it("flags an orphaned invoice line beside a live remainder, and names the driver from the audit row", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const o = await a.order(0); // nothing counted as invoiced
    await a.invoice(o.orderId, { orderItemId: null, qty: 10 }); // ...yet an invoice bills the product
    await a.audit(o.orderId, a.driverUserId, "2026-10-05T10:00:00Z");
    // A NEWER row for the same entity id in ANOTHER tenant must never be read.
    await b.audit(o.orderId, b.driverUserId, "2026-10-06T10:00:00Z", b.tenantId);

    const out = await read(a.tenantId, o.orderId, staff(a.tenantId));

    expect(out.invoicesNeedReview).toEqual({
      flagged: true,
      reason: ORDER_INVOICES_NEED_REVIEW_MESSAGE,
      flaggedAtStop: { by: "Dana Driver", at: "2026-10-05T10:00:00.000Z" },
    });
    // The read still returns the whole order detail around the new field.
    expect(out.id).toBe(o.orderId);
    expect(out.lineItems).toHaveLength(1);
  });

  it("shows no stop line when the newest audit row is not a stop-completion row", async () => {
    const a = await seedTenant();
    const o = await a.order(0);
    await a.invoice(o.orderId, { orderItemId: null, qty: 10 });
    await a.audit(o.orderId, a.driverUserId, "2026-10-05T10:00:00Z"); // a stop-completion row...
    await a.audit(o.orderId, a.driverUserId, "2026-10-06T10:00:00Z", a.tenantId, "office-recovery");

    const out = await read(a.tenantId, o.orderId, staff(a.tenantId));

    expect(out.invoicesNeedReview).toEqual({
      flagged: true,
      reason: ORDER_INVOICES_NEED_REVIEW_MESSAGE,
    });
  });

  it("flags with no audit row at all — the flag is the predicate, never the row — and for a tenant admin too", async () => {
    const a = await seedTenant();
    const o = await a.order(0);
    await a.invoice(o.orderId, { orderItemId: null, qty: 10 });

    const out = await read(a.tenantId, o.orderId, staff(a.tenantId, "TENANT_ADMIN"));

    expect(out.invoicesNeedReview).toEqual({
      flagged: true,
      reason: ORDER_INVOICES_NEED_REVIEW_MESSAGE,
    });
  });

  it("an audit row alone never flags an order whose invoices are in step", async () => {
    const a = await seedTenant();
    const o = await a.order(10);
    await a.invoice(o.orderId, { orderItemId: o.lineId, qty: 10 }); // linked, counter == billed
    await a.audit(o.orderId, a.driverUserId, "2026-10-05T10:00:00Z");

    const out = await read(a.tenantId, o.orderId, staff(a.tenantId));

    expect(out.invoicesNeedReview).toEqual({ flagged: false });
  });

  it("is not flagged with no invoice, or with only a VOID one", async () => {
    const a = await seedTenant();
    const none = await a.order(0);
    const voided = await a.order(0);
    await a.invoice(voided.orderId, { orderItemId: null, qty: 10 }, "VOID");

    expect((await read(a.tenantId, none.orderId, staff(a.tenantId))).invoicesNeedReview).toEqual({
      flagged: false,
    });
    expect((await read(a.tenantId, voided.orderId, staff(a.tenantId))).invoicesNeedReview).toEqual({
      flagged: false,
    });
  });

  it("flags a counter that disagrees with what the invoices bill, even with nothing left to bill", async () => {
    const a = await seedTenant();
    const o = await a.order(10); // counter says all 10 invoiced...
    await a.invoice(o.orderId, { orderItemId: o.lineId, qty: 6 }); // ...the invoice bills 6

    const out = await read(a.tenantId, o.orderId, staff(a.tenantId));

    expect(out.invoicesNeedReview.flagged).toBe(true);
  });

  it("a buyer's read of a flagged order carries no field and never runs the predicate", async () => {
    const a = await seedTenant();
    const o = await a.order(0);
    await a.invoice(o.orderId, { orderItemId: null, qty: 10 });
    const spy = jest.spyOn(partition, "invoicesNeedReview");
    try {
      const buyer = {
        sub: a.customerUserId,
        username: "buyer",
        role: "CUSTOMER",
        tenantId: a.tenantId,
        tenantSlug: "x",
        type: "BUYER",
      } as never;
      const out = await read(a.tenantId, o.orderId, buyer);

      expect(out.id).toBe(o.orderId);
      expect(out).not.toHaveProperty("invoicesNeedReview");
      expect(JSON.stringify(out)).not.toContain("invoicesNeedReview");
      expect(spy).not.toHaveBeenCalled();

      // ...while the same order read as staff does run it (the spy is live, not vacuous).
      await read(a.tenantId, o.orderId, staff(a.tenantId));
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("another tenant's flagged order is not found from this tenant", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const o = await b.order(0);
    await b.invoice(o.orderId, { orderItemId: null, qty: 10 });

    await expect(read(a.tenantId, o.orderId, staff(a.tenantId))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
