/**
 * SA-762r (real Postgres): POST /orders/counter-sale/:orderId/void through the REAL CounterSaleVoidService,
 * OrdersService.cancelOrderInTx and InvoicesService.voidPaymentInTx / voidInvoiceInTx, on the Object.create harness of
 * credit-notes/restore-source-gone-services.db.spec.ts (prisma is the real connected service; unknown collaborators are
 * no-ops) and the REAL counter-tender advisory lock (db-locks.ts, its own pg pool).
 *
 *   (a) a same-day cash + card sale on two sibling invoices: payments VOID, invoices VOID, order and lines CANCELLED, stock
 *       back to the pre-sale count, ONE CANCEL movement, ONE audit row, handBack {CASH, CARD}.
 *   (b) a boxed sale rung through the REAL create(): stock after the void equals the stock before the sale.
 *   (c) the race: two concurrent voids -> both 200, the second replayed:true with the same handBack, one audit row, one
 *       set of VOID writes, stock restored once.
 *   (d) a sale the office already cancelled -> 409 COUNTER_SALE_VOIDED, nothing moves.
 *   (e) the counter-tender lock held elsewhere past the 10 s wait -> 503 COUNTER_SALE_VOID_BUSY, nothing moves.
 *   (f) a void waits behind a tender (same lock family + key) and completes when the tender releases: serialized.
 *   (g) a recorded cash refund -> 409 ORDER_HAS_CASH_REFUND, nothing moves.
 *   (h) atomic: a failure AFTER the tender was voided (the order left DELIVERED) rolls the tender void back.
 * NOT covered here: "refused after the day is closed" (the SA-750 close lands later) and a full ring() same-key replay
 * (the tender lock is proven by (f); ring()'s own locked tender is counter-sale-replay.db.spec.ts's ground).
 *
 * NOT RUN by the builder (no Postgres on the build machine): the DB lane runs it (`npm run local:test:db`, test tenant
 * only, collected only by jest.db.config.js). Every tenant is a throwaway `qa-b762v-<run>` slug (assertTestTenant).
 */
import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { EncryptionService } from "../../common/encryption.service";
import { SystemConfigService } from "../../system-config/system-config.service";
import { CreditNotesService } from "../../credit-notes/credit-notes.service";
import { InvoicesService } from "../../invoices/invoices.service";
import { OrdersService } from "../orders.service";
import { withAdvisoryLock } from "../../common/db-locks";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import { CounterSaleVoidService } from "./counter-sale-void.service";
import { toCounterOrderItem } from "./counter-sale-lines";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const PACK = 12;

describeDb("SA-762r: void a counter sale, real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: OrdersService;
  let voids: CounterSaleVoidService;
  const tenantIds: string[] = [];
  let seq = 0;
  const gatewayCalls: unknown[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    // Unknown collaborators answer any method with a no-op (never `then`).
    const anyMethod = new Proxy(
      {},
      { get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()) },
    );
    const gateway = { emitOrderStatusChanged: (...a: unknown[]) => gatewayCalls.push(a) };
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
      commissionEngine: { syncInvoiceCommissionSafe: async () => undefined },
      logger: new Logger("b762v-invoices"),
    });
    orders = Object.assign(Object.create(OrdersService.prototype), {
      prisma,
      creditNotes,
      invoicesService: invoices,
      gateway: anyMethod,
      systemConfig: new SystemConfigService(
        prisma,
        new EncryptionService({ get: () => undefined } as any),
      ),
      entitlements: { hasFlag: async () => true },
      sellingRestrictions: { assertLinesSellable: async () => undefined },
      authGuard: { assertAuthorizedOrThrow: async () => undefined },
      promotionsService: { activeForCatalog: async () => [] },
      ledger: anyMethod,
      tenantCtx,
      logger: new Logger("b762v-orders"),
    });
    voids = new CounterSaleVoidService(orders, invoices, prisma, gateway as never);
  });

  afterAll(async () => {
    const swallow = () => undefined;
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      const ids = (await prisma.order.findMany({ where: { tenantId }, select: { id: true } })).map(
        (o) => o.id,
      );
      await prisma.orderIdempotencyKey
        .deleteMany({ where: { orderId: { in: ids } } })
        .catch(swallow);
      await prisma.return.deleteMany(where).catch(swallow);
      await prisma.stockMovement.deleteMany(where).catch(swallow);
      await prisma.invoicePayment.deleteMany(where).catch(swallow);
      await prisma.invoiceItem.deleteMany(where).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.orderItem.deleteMany(where).catch(swallow);
      await prisma.order.deleteMany(where).catch(swallow);
      await prisma.product.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.auditLog.deleteMany(where).catch(swallow);
      await prisma.systemConfig.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
  }, 120_000);

  /** A tenant with an operator, a customer and a stocked product. */
  async function base(label: string, pack: number | null = null) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-b762v-${RUN}-${seq}-${label}`,
      "counter-sale-void.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `b762v ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "OPERATOR", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
    });
    const product = await prisma.product.create({
      data: {
        tenantId,
        name: `P ${slug}`,
        unit: "each",
        unitsPerBox: pack,
        pricePerUnit: 10,
        currentStock: 100,
      },
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
    return { tenantId, user, customer, product, jwt };
  }
  type Base = Awaited<ReturnType<typeof base>>;

  /** Two sibling invoices on `orderId`: a $30 CASH payment on the first, a $20 card payment on the second. */
  async function invoicesWithTender(b: Base, orderId: string, orderItemId: string, tag: string) {
    const mk = async (n: number, amount: number, method: "CASH" | "CREDIT_CARD") => {
      const invoice = await prisma.invoice.create({
        data: {
          tenantId: b.tenantId,
          customerId: b.customer.id,
          orderId,
          invoiceNumber: `INV-B762V-${RUN}-${tag}-${n}`,
          status: "PAID",
          subtotal: amount,
          taxAmount: 0,
          total: amount,
        },
      });
      await prisma.invoiceItem.create({
        data: {
          tenantId: b.tenantId,
          invoiceId: invoice.id,
          orderItemId,
          productId: b.product.id,
          description: "line",
          qty: 1,
          unitPrice: amount,
          subtotal: amount,
        } as any,
      });
      const payment = await prisma.invoicePayment.create({
        data: {
          tenantId: b.tenantId,
          invoiceId: invoice.id,
          amount,
          method,
          status: "PAID",
          paymentNumber: `PAY-B762V-${RUN}-${tag}-${n}`,
        } as any,
      });
      return { invoice, payment };
    };
    return [await mk(1, 30, "CASH"), await mk(2, 20, "CREDIT_CARD")];
  }

  /**
   * A DELIVERED counter sale (created now) of `qty` pieces: the product shows the post-sale count (100 - qty),
   * as the sale's own decrement leaves it.
   */
  async function seedSale(label: string, qty = 5) {
    const b = await base(label);
    await prisma.product.update({ where: { id: b.product.id }, data: { currentStock: 100 - qty } });
    const order = await prisma.order.create({
      data: {
        tenantId: b.tenantId,
        customerId: b.customer.id,
        orderNumber: `ORD-B762V-${RUN}-${seq}`,
        subtotal: 50,
        tax: 0,
        total: 50,
        status: "DELIVERED",
        counterSale: true,
        deliveredAt: new Date(),
      } as any,
    });
    const item = await prisma.orderItem.create({
      data: {
        tenantId: b.tenantId,
        orderId: order.id,
        productId: b.product.id,
        name: b.product.name,
        qty,
        unitPrice: 10,
        subtotal: 50,
        invoicedQty: qty,
      } as any,
    });
    const legs = await invoicesWithTender(b, order.id, item.id, label);
    return { ...b, order, item, legs };
  }
  type Sale = Awaited<ReturnType<typeof seedSale>>;

  const run = <T>(s: Base, fn: () => Promise<T>) => tenantCtx.run(s.tenantId, fn);
  const doVoid = (s: Sale, reason = "rang the wrong item") =>
    run(s, () => voids.voidSale(s.order.id, { reason }, s.jwt as never));

  /** Everything a refused or rolled-back void must NOT have changed (and what a void does change). */
  async function snapshot(s: Sale) {
    const [order, items, product, invoices, payments, audits, movements] = await Promise.all([
      prisma.order.findUnique({ where: { id: s.order.id } }),
      prisma.orderItem.findMany({ where: { orderId: s.order.id }, orderBy: { id: "asc" } }),
      prisma.product.findUnique({ where: { id: s.product.id } }),
      prisma.invoice.findMany({
        where: { orderId: s.order.id },
        orderBy: { invoiceNumber: "asc" },
      }),
      prisma.invoicePayment.findMany({
        where: { invoice: { orderId: s.order.id } },
        orderBy: { paymentNumber: "asc" },
      }),
      prisma.auditLog.count({
        where: { tenantId: s.tenantId, action: "counter-sale.voided", entityId: s.order.id },
      }),
      prisma.stockMovement.count({ where: { productId: s.product.id, notes: "CANCEL" } }),
    ]);
    return {
      orderStatus: order!.status,
      itemStatuses: items.map((i) => i.status),
      stock: Number(product!.currentStock),
      invoiceStatuses: invoices.map((i) => i.status),
      paymentStatuses: payments.map((p) => p.status),
      audits,
      cancelMovements: movements,
    };
  }
  const code = async (p: Promise<unknown>) => {
    const e: any = await p.catch((x) => x);
    return { status: e?.getStatus?.(), body: e?.getResponse?.() };
  };

  it("(a) a same-day cash + card sale: everything voided, stock back, one movement, one audit row, handBack CASH + CARD", async () => {
    const s = await seedSale("happy");
    expect(await doVoid(s)).toEqual({ voided: true, handBack: { CASH: 30, CARD: 20 } });
    expect(await snapshot(s)).toEqual({
      orderStatus: "CANCELLED",
      itemStatuses: ["CANCELLED"],
      stock: 100,
      invoiceStatuses: ["VOID", "VOID"],
      paymentStatuses: ["VOID", "VOID"],
      audits: 1,
      cancelMovements: 1,
    });
    const audit = await prisma.auditLog.findFirst({
      where: { tenantId: s.tenantId, action: "counter-sale.voided", entityId: s.order.id },
    });
    expect(audit?.meta).toMatchObject({
      orderId: s.order.id,
      reason: "rang the wrong item",
      handBack: { CASH: 30, CARD: 20 },
      actor: s.user.id,
    });
    // a later repeat is a replay of that row and writes nothing
    expect(await doVoid(s)).toEqual({
      voided: true,
      replayed: true,
      handBack: { CASH: 30, CARD: 20 },
    });
    expect((await snapshot(s)).audits).toBe(1);
  }, 120_000);

  it("(b) a boxed sale rung through the real create(): the stock after the void equals the stock before the sale", async () => {
    const b = await base("boxed", PACK);
    const staff = b.jwt as never;
    const lineInput = { productId: b.product.id, boxes: 2, pieces: 3 } as never;
    const created: any = await run(b, () =>
      (orders as any).create(
        {
          customerId: b.customer.id,
          items: [toCounterOrderItem(lineInput, PACK)],
          idempotencyKey: `cs-void-${randomUUID()}`,
        },
        staff,
        { skipAutoMerge: true, counterSale: true },
      ),
    );
    const afterSale = await prisma.product.findUniqueOrThrow({ where: { id: b.product.id } });
    expect(Number(afterSale.currentStock)).toBe(100 - 27); // create()'s piece decrement: 2 x 12 + 3
    await prisma.order.update({
      where: { id: created.id },
      data: { status: "DELIVERED", deliveredAt: new Date(), counterSale: true },
    });
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: created.id } });
    await invoicesWithTender(b, created.id, item.id, "boxed");
    const sale = { ...b, order: created, item, legs: [] } as unknown as Sale;
    await doVoid(sale);
    const restored = await prisma.product.findUniqueOrThrow({ where: { id: b.product.id } });
    expect(Number(restored.currentStock)).toBe(100); // back to the pre-sale count, not 100 - 27 + 2
  }, 120_000);

  it("(c) two concurrent voids: both 200, the second a replay with the same handBack, one audit row, stock restored once", async () => {
    const s = await seedSale("race");
    const [r1, r2] = await Promise.all([doVoid(s), doVoid(s)]);
    expect([r1, r2].every((r) => r.voided === true)).toBe(true);
    expect([r1, r2].filter((r) => r.replayed === true)).toHaveLength(1);
    expect(r1.handBack).toEqual(r2.handBack);
    expect(r1.handBack).toEqual({ CASH: 30, CARD: 20 });
    expect(await snapshot(s)).toEqual({
      orderStatus: "CANCELLED",
      itemStatuses: ["CANCELLED"],
      stock: 100,
      invoiceStatuses: ["VOID", "VOID"],
      paymentStatuses: ["VOID", "VOID"],
      audits: 1,
      cancelMovements: 1,
    });
  }, 120_000);

  it("(d) a sale the office already cancelled (no void audit row) is 409 COUNTER_SALE_VOIDED and nothing moves", async () => {
    const s = await seedSale("office");
    await prisma.order.update({ where: { id: s.order.id }, data: { status: "CANCELLED" } });
    await prisma.invoice.updateMany({ where: { orderId: s.order.id }, data: { status: "VOID" } });
    await prisma.invoicePayment.updateMany({
      where: { invoice: { orderId: s.order.id } },
      data: { status: "VOID" },
    });
    const before = await snapshot(s);
    expect(await code(doVoid(s))).toMatchObject({
      status: 409,
      body: { code: "COUNTER_SALE_VOIDED" },
    });
    expect(await snapshot(s)).toEqual(before);
  }, 120_000);

  it("(e) the counter-tender lock held past the 10 s wait -> 503 COUNTER_SALE_VOID_BUSY and nothing moves", async () => {
    const s = await seedSale("busy");
    const before = await snapshot(s);
    const held = await withAdvisoryLock(
      { family: "counter-tender", key: s.order.id, mode: "wait" },
      async () => code(doVoid(s)),
    );
    expect(held.acquired && held.value).toMatchObject({
      status: 503,
      body: { code: "COUNTER_SALE_VOID_BUSY" },
    });
    expect(await snapshot(s)).toEqual(before);
  }, 120_000);

  it("(f) a void waits behind a tender holding the same lock and completes once it releases (serialized)", async () => {
    const s = await seedSale("serial");
    const before = await snapshot(s);
    let finished = false;
    let pending: Promise<unknown> = Promise.resolve();
    const held = await withAdvisoryLock(
      { family: "counter-tender", key: s.order.id, mode: "wait" },
      async () => {
        pending = doVoid(s).then((r) => {
          finished = true;
          return r;
        });
        await new Promise((r) => setTimeout(r, 2_000));
        expect(finished).toBe(false); // still waiting on the tender's lock
        expect(await snapshot(s)).toEqual(before); // and has written nothing
      },
    );
    expect(held.acquired).toBe(true);
    await expect(pending).resolves.toMatchObject({ voided: true });
    expect((await snapshot(s)).orderStatus).toBe("CANCELLED");
  }, 120_000);

  it("(g) a recorded cash refund -> 409 ORDER_HAS_CASH_REFUND and nothing moves", async () => {
    const s = await seedSale("refund");
    await prisma.return.create({
      data: {
        tenantId: s.tenantId,
        orderId: s.order.id,
        customerId: s.customer.id,
        reason: "DAMAGED",
        status: "PROCESSED",
        refundMethod: "EXTERNAL_REFUND",
        refundAmount: 10,
        refundedAt: new Date(),
      } as any,
    });
    const before = await snapshot(s);
    expect(await code(doVoid(s))).toMatchObject({
      status: 409,
      body: { code: "ORDER_HAS_CASH_REFUND" },
    });
    expect(await snapshot(s)).toEqual(before);
  }, 120_000);

  it("(h) atomic: a failure after the tender was voided (the order left DELIVERED) rolls the whole void back", async () => {
    const s = await seedSale("atomic");
    await prisma.order.update({ where: { id: s.order.id }, data: { status: "OUT_FOR_DELIVERY" } });
    const before = await snapshot(s);
    expect(before.paymentStatuses).toEqual(["PAID", "PAID"]);
    expect(await code(doVoid(s))).toMatchObject({
      status: 409,
      body: { code: "ORDER_CHANGED_DURING_EDIT" },
    });
    expect(await snapshot(s)).toEqual(before); // the tender void, run first, was rolled back with the rest
  }, 120_000);
});
