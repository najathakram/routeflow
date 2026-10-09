/**
 * SA-762r F5 (real Postgres): the OFFICE cancel of a CONFIRMED order, pinned so it reads IDENTICAL before and after
 * the cancelOrderInTx extraction (order-cancel-tx.ts). Drives the REAL OrdersService.changeStatus -> CANCELLED through the
 * same Object.create harness as credit-notes/restore-source-gone-services.db.spec.ts, then asserts what the unwind left:
 * the stock credit (+ one CANCEL movement), every live invoice VOID, the wallet (advance) money handed back, the lines
 * CANCELLED, the order CANCELLED. Run it on the pre-extraction head and on this branch: both must pass unchanged.
 * Also: PATCH status CANCELLED on a DELIVERED order is still a 400 and moves nothing.
 *
 * NOT RUN by the builder (no Postgres on the build machine): the DB lane runs it (`npm run local:test:db`, test tenant
 * only, collected only by jest.db.config.js). Every tenant is a throwaway `qa-b762c-<run>` slug (assertTestTenant).
 */
import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { OrdersService } from "./orders.service";
import { InvoicesService } from "../invoices/invoices.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("SA-762r F5: office cancel of a CONFIRMED order, real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: OrdersService;
  const tenantIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    // Object.create bypasses Nest DI: prisma is the REAL connected service, so each method runs its real transaction.
    // Unknown collaborators answer any method with a no-op (never `then`).
    const anyMethod = new Proxy(
      {},
      { get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()) },
    );
    const creditNotes = new CreditNotesService(
      prisma,
      anyMethod as any,
      anyMethod as any,
      { syncInvoiceCommissionSafe: async () => undefined } as any,
      anyMethod as any,
    );
    const invoices = Object.assign(Object.create(InvoicesService.prototype), {
      prisma,
      creditNotes,
      ledger: anyMethod,
      gateway: anyMethod,
      commissionEngine: anyMethod,
      logger: new Logger("b762c-invoices"),
    });
    orders = Object.assign(Object.create(OrdersService.prototype), {
      prisma,
      creditNotes,
      invoicesService: invoices,
      gateway: anyMethod,
      authGuard: anyMethod,
      sellingRestrictions: anyMethod,
      logger: new Logger("b762c-orders"),
    });
  });

  afterAll(async () => {
    const swallow = () => undefined;
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.stockMovement.deleteMany(where).catch(swallow);
      await prisma.invoicePayment.deleteMany(where).catch(swallow);
      await prisma.advancePayment.deleteMany(where).catch(swallow);
      await prisma.invoiceItem.deleteMany(where).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.orderItem.deleteMany(where).catch(swallow);
      await prisma.order.deleteMany(where).catch(swallow);
      await prisma.product.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.auditLog.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  /** A `status` order (1 line of 2 pieces, product stock 10 = AFTER the sale's decrement) with one SENT invoice that
   *  holds a $30 ADVANCE application (the advance wallet: amount 100, balance 70). */
  async function seed(label: string, status: "CONFIRMED" | "DELIVERED") {
    seq += 1;
    const slug = assertTestTenant(`qa-b762c-${RUN}-${seq}-${label}`, "order-cancel-tx.db.spec.ts");
    const tenant = await prisma.tenant.create({ data: { slug, name: `b762c ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "OPERATOR", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
    });
    const product = await prisma.product.create({
      data: { tenantId, name: `P ${slug}`, unit: "each", pricePerUnit: 50, currentStock: 10 },
    });
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderNumber: `ORD-B762C-${RUN}-${seq}`,
        subtotal: 100,
        tax: 0,
        total: 100,
        status,
      } as any,
    });
    const item = await prisma.orderItem.create({
      data: {
        tenantId,
        orderId: order.id,
        productId: product.id,
        name: product.name,
        qty: 2,
        unitPrice: 50,
        subtotal: 100,
      } as any,
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderId: order.id,
        invoiceNumber: `INV-B762C-${RUN}-${seq}`,
        status: "SENT",
        subtotal: 100,
        taxAmount: 0,
        total: 100,
      },
    });
    const advance = await prisma.advancePayment.create({
      data: { tenantId, customerId: customer.id, amount: 100, balance: 70, method: "CASH" },
    });
    await prisma.invoicePayment.create({
      data: {
        tenantId,
        invoiceId: invoice.id,
        amount: 30,
        method: "ADVANCE",
        status: "PAID",
        advancePaymentId: advance.id,
        paymentNumber: `PAY-B762C-${RUN}-${seq}`,
      } as any,
    });
    const jwt = {
      sub: user.id,
      username: slug,
      role: "OPERATOR" as any,
      status: "ACTIVE" as any,
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    };
    return { tenantId, order, item, product, invoice, advance, jwt };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;

  async function snapshot(s: Seed) {
    const [order, item, product, invoice, advance, advancePays, movements] = await Promise.all([
      prisma.order.findUnique({ where: { id: s.order.id } }),
      prisma.orderItem.findUnique({ where: { id: s.item.id } }),
      prisma.product.findUnique({ where: { id: s.product.id } }),
      prisma.invoice.findUnique({ where: { id: s.invoice.id } }),
      prisma.advancePayment.findUnique({ where: { id: s.advance.id } }),
      prisma.invoicePayment.count({ where: { invoiceId: s.invoice.id, method: "ADVANCE" } }),
      prisma.stockMovement.count({ where: { productId: s.product.id } }),
    ]);
    return {
      orderStatus: order!.status,
      itemStatus: item!.status,
      stock: Number(product!.currentStock),
      invoiceStatus: invoice!.status,
      advanceBalance: Number(advance!.balance),
      advancePayments: advancePays,
      movements,
    };
  }

  it("cancelling a CONFIRMED order: order + lines CANCELLED, stock +2, one CANCEL movement, invoice VOID, the advance handed back", async () => {
    const s = await seed("confirmed", "CONFIRMED");
    await tenantCtx.run(s.tenantId, () =>
      orders.changeStatus(s.order.id, { status: "CANCELLED" } as any, s.jwt as any),
    );
    expect(await snapshot(s)).toEqual({
      orderStatus: "CANCELLED",
      itemStatus: "CANCELLED",
      stock: 12,
      invoiceStatus: "VOID",
      advanceBalance: 100,
      advancePayments: 0,
      movements: 1,
    });
    const movement = await prisma.stockMovement.findFirst({ where: { productId: s.product.id } });
    expect(movement?.notes).toBe("CANCEL");
  }, 120_000);

  it("PATCH status CANCELLED on a DELIVERED order is still a 400 and moves nothing", async () => {
    const s = await seed("delivered", "DELIVERED");
    const before = await snapshot(s);
    const err: any = await tenantCtx
      .run(s.tenantId, () =>
        orders.changeStatus(s.order.id, { status: "CANCELLED" } as any, s.jwt as any),
      )
      .catch((e) => e);
    expect(err?.getStatus?.()).toBe(400);
    expect(await snapshot(s)).toEqual(before);
    expect(before.orderStatus).toBe("DELIVERED");
  }, 120_000);
});
