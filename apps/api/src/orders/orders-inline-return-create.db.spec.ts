/**
 * #2094 PR-A (SA-194 / SA-221, Opus R2) — real-Postgres pins THROUGH OrdersService.create(). The
 * sibling inline-returns-in-order.db.spec.ts drives captureAndIssueInTx directly; this file runs the
 * real create() (its retry loop, its tx, its credit gate) so the order-side wiring is proven too:
 *
 *   1. commit-together: one order + ONE Return + ONE credit note + the capped intent.
 *   2. exposure (SA-194): the credit-limit gate is read for the new order; a refused create leaves no
 *      order, no Return, no credit note; an accepted one does not net the credit note into exposure.
 *   3. a forced order-number P2002 collision (two concurrent creates compute the same next number):
 *      each customer ends with exactly ONE Return and ONE credit note, and the credit-note numbers
 *      are exactly the numbers reserved BEFORE the retry loop (a retry reuses, never re-reserves).
 *   4. the lock: TWO new orders for one customer over ONE sold line: the pieces matched to the sold
 *      invoice line never exceed what was sold (the customer advisory lock serializes them; the
 *      single-order case is already serialized by captureInTx's own Order lock).
 *   5. DRIVER_CAP through create(): a driver's over-cap return on a new order is HELD: the order
 *      commits, the Return is RECEIVED/DRIVER_CAP, no credit note, no intent, no number consumed.
 *
 * Builds a REAL OrdersService via `Object.create` (no Nest DI, like order-idempotency-key.db.spec.ts)
 * with the real InlineReturnsService, CreditNotesService, NumberingService and SystemConfigService; the
 * collaborators create() only calls for side effects (gateway emits, selling restrictions, the
 * authorization guard, entitlements) are lightweight fakes. NOT RUN on the MacBook that wrote it (no
 * Postgres there): F2's DB lane runs it and adjusts any fixture field the schema demands.
 * Run via `npm run local:test:db`; collected only by jest.db.config.js.
 */

// Same module mocks as order-idempotency-key.db.spec.ts (ESM-only imports Jest cannot parse).
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
import { NumberingService } from "../import/numbering.service";
import { IdempotencyService } from "../common/idempotency.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { InlineReturnsQuoteService } from "../returns/inline-returns-quote.service";
import { InlineReturnsService } from "../returns/inline-returns.service";
import { OrdersService } from "./orders.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("#2094 — a return inside POST /orders through create(), real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient; // superuser fixture client, deliberately unscoped
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  let inlineSvc: any;
  const reserved: string[] = [];
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-2094-create-${run}`, "orders-inline-return-create.db.spec.ts");
  let tenantId = "";
  const customerIds: string[] = [];
  const productIds: string[] = [];
  const userIds: string[] = [];
  const orderIds: string[] = [];
  const invoiceIds: string[] = [];

  const staff = (): JwtPayload =>
    ({
      sub: userIds[0] ?? "op",
      username: "operator",
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    }) as JwtPayload;

  async function seedCustomer(tag: string, creditLimit?: number) {
    const product = await raw.product.create({
      data: { name: `${tag} product ${run}`, unit: "each", pricePerUnit: "10.00", tenantId },
    });
    productIds.push(product.id);
    const u = await raw.user.create({
      data: {
        email: `${tag}-c-${run}@example.test`,
        username: `${tag}-c-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    userIds.push(u.id);
    const c = await raw.customer.create({
      data: {
        userId: u.id,
        businessName: `${tag} co`,
        contactName: "2094 Tester",
        tenantId,
        ...(creditLimit != null ? { creditLimit: creditLimit.toFixed(2) } : {}),
      },
    });
    customerIds.push(c.id);
    return { productId: product.id, customerId: c.id };
  }

  const create = (
    f: { customerId: string; productId: string },
    qty: number,
    ret?: any,
    user = staff(),
  ) =>
    tenantCtx.run(tenantId, () =>
      orders.create(
        {
          customerId: f.customerId,
          items: [{ productId: f.productId, qty }],
          ...(ret ? { inlineReturn: ret } : {}),
        },
        user,
        { skipAutoMerge: true },
      ),
    );
  const ret = (productId: string, qty: number, returnKey: string) => ({
    items: [{ productId, qty }], // $10 unreferenced price unless a sold line matches
    returnKey,
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const idempotency = new IdempotencyService();
    const numbering = new NumberingService(prisma);
    const ledger = new RegulatedLedgerService(prisma);
    const systemConfig = new SystemConfigService(
      prisma,
      new EncryptionService({ get: () => undefined } as any),
    );
    const creditNotes = Object.assign(Object.create(CreditNotesService.prototype), {
      prisma,
      gateway: { emitCreditNoteCreated: jest.fn() },
      ledger,
      commissionEngine: {},
      numbering,
      logger: new Logger(CreditNotesService.name),
    });
    inlineSvc = Object.assign(Object.create(InlineReturnsService.prototype), {
      prisma,
      gateway: { emitCreditNoteCreated: jest.fn() },
      ledger,
      creditNotes,
      numbering,
      addonService: { hasAddon: async () => true },
      quoteService: new InlineReturnsQuoteService(prisma, systemConfig),
      idempotency,
    });
    // Record every credit-note number reserved ahead of a retry loop.
    const realReserve = inlineSvc.reserveCreditNoteNumber.bind(inlineSvc);
    inlineSvc.reserveCreditNoteNumber = async () => {
      const n = await realReserve();
      reserved.push(n);
      return n;
    };
    orders = Object.assign(Object.create(OrdersService.prototype), {
      prisma,
      gateway: { emitOrderCreated: jest.fn(), emitUrgentOrder: jest.fn() },
      systemConfig,
      entitlements: { hasFlag: async () => true },
      sellingRestrictions: { assertLinesSellable: async () => undefined },
      authGuard: { assertAuthorizedOrThrow: async () => undefined },
      promotionsService: { activeForCatalog: async () => [] },
      creditNotes,
      ledger,
      tenantCtx,
      logger: new Logger(OrdersService.name),
      inlineReturns: inlineSvc,
    });
    tenantId = (await raw.tenant.create({ data: { slug, name: `2094 Create ${slug}` } })).id;
    const op = await raw.user.create({
      data: { email: `op-${run}@example.test`, username: `op-${run}`, role: "OPERATOR", tenantId },
    });
    userIds.unshift(op.id);
  }, 120_000);

  afterAll(async () => {
    const allOrders = await raw.order.findMany({
      where: { OR: [{ tenantId }, { id: { in: orderIds } }] },
      select: { id: true },
    });
    const ids = allOrders.map((o) => o.id);
    await raw.orderCreditNote.deleteMany({ where: { orderId: { in: ids } } });
    await raw.returnItem.deleteMany({ where: { return: { orderId: { in: ids } } } });
    await raw.return.deleteMany({ where: { orderId: { in: ids } } });
    await raw.creditNote.deleteMany({ where: { tenantId } });
    await raw.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await raw.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await raw.order.deleteMany({ where: { id: { in: ids } } });
    await raw.customer.deleteMany({ where: { id: { in: customerIds } } });
    await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
    await raw.product.deleteMany({ where: { id: { in: productIds } } });
    await raw.user.deleteMany({ where: { id: { in: userIds } } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("commit-together: one order, ONE Return, ONE credit note, and the intent capped at the order balance", async () => {
    const f = await seedCustomer("commit");
    const o = await create(f, 1, ret(f.productId, 7, `k-commit-${run}`)); // order $10, return $70
    orderIds.push(o.id);
    expect(await raw.return.count({ where: { orderId: o.id } })).toBe(1);
    const cns = await raw.creditNote.findMany({ where: { customerId: f.customerId } });
    expect(cns).toHaveLength(1);
    expect(Number(cns[0].amount)).toBeCloseTo(70, 2); // minted in full
    const intents = await raw.orderCreditNote.findMany({ where: { orderId: o.id } });
    expect(intents.reduce((s, i) => s + Number(i.amount), 0)).toBeLessThanOrEqual(
      Number(o.total) + 0.005,
    );
  }, 60_000);

  it("exposure: a create refused by the credit-limit gate leaves no order, no Return and no credit note; an accepted one does not net the credit note into exposure", async () => {
    const tight = await seedCustomer("gate-tight", 5); // limit $5, order $10
    await expect(
      create(tight, 1, ret(tight.productId, 3, `k-gate-a-${run}`)),
    ).rejects.toBeDefined();
    expect(await raw.order.count({ where: { customerId: tight.customerId } })).toBe(0);
    expect(await raw.return.count({ where: { customerId: tight.customerId } })).toBe(0);
    expect(await raw.creditNote.count({ where: { customerId: tight.customerId } })).toBe(0);

    const roomy = await seedCustomer("gate-roomy", 100);
    const o = await create(roomy, 1, ret(roomy.productId, 3, `k-gate-b-${run}`)); // order $10, credit $30
    orderIds.push(o.id);
    // SA-194: the unapplied credit note never loosens the gate: exposure still counts the whole order.
    const { loadCreditExposure } = await import("../invoices/credit-exposure");
    const exposure = await tenantCtx.run(tenantId, () =>
      loadCreditExposure(prisma.forTenant(), roomy.customerId),
    );
    expect(Number(exposure.counted)).toBeGreaterThanOrEqual(Number(o.total) - 0.005);
  }, 60_000);

  it("a forced order-number P2002 collision: each customer ends with ONE Return and ONE credit note, at the numbers reserved before the retry loop", async () => {
    const a = await seedCustomer("p2002-a");
    const b = await seedCustomer("p2002-b");
    reserved.length = 0;
    // Two concurrent creates compute the same next order number: one wins, the other hits P2002 and retries.
    const [oa, ob] = await Promise.all([
      create(a, 1, ret(a.productId, 3, `k-p2002-a-${run}`)),
      create(b, 1, ret(b.productId, 3, `k-p2002-b-${run}`)),
    ]);
    orderIds.push(oa.id, ob.id);
    for (const [f, o] of [
      [a, oa],
      [b, ob],
    ] as const) {
      expect(await raw.return.count({ where: { orderId: o.id } })).toBe(1);
      expect(await raw.creditNote.count({ where: { customerId: f.customerId } })).toBe(1);
    }
    const numbers = (await raw.creditNote.findMany({ where: { tenantId } }))
      .filter((c) => [a.customerId, b.customerId].includes(c.customerId))
      .map((c) => c.creditNoteNumber)
      .sort();
    expect(numbers).toEqual([...reserved].sort()); // a retry reuses the reserved number, never re-reserves
  }, 60_000);

  it("the lock: two new orders for one customer over ONE sold line never match more pieces than were sold", async () => {
    const f = await seedCustomer("lock");
    const soldOrder = await raw.order.create({
      data: { customerId: f.customerId, tenantId, status: "DELIVERED", total: "100.00" },
    });
    orderIds.push(soldOrder.id);
    const inv = await raw.invoice.create({
      data: {
        invoiceNumber: `INV-2094-${run}`,
        customerId: f.customerId,
        orderId: soldOrder.id,
        tenantId,
        status: "SENT",
        subtotal: "100.00",
        total: "100.00",
      },
    });
    invoiceIds.push(inv.id);
    const line = await raw.invoiceItem.create({
      data: {
        invoiceId: inv.id,
        tenantId,
        description: "sold line",
        productId: f.productId,
        qty: "10",
        unitPrice: "10.00",
        subtotal: "100.00",
      },
    });
    const [o1, o2] = await Promise.all([
      create(f, 1, ret(f.productId, 7, `k-lock-1-${run}`)),
      create(f, 1, ret(f.productId, 7, `k-lock-2-${run}`)),
    ]);
    orderIds.push(o1.id, o2.id);
    const matched = await raw.returnItem.aggregate({
      where: { sourceInvoiceItemId: line.id, return: { customerId: f.customerId, kind: "INLINE" } },
      _sum: { qty: true },
    });
    expect(Number(matched._sum.qty ?? 0)).toBeLessThanOrEqual(10);
  }, 60_000);

  it("a create whose return prices to $0 mints no credit note and writes no intent (SA-261: the reserved number is burned, knowingly)", async () => {
    const f = await seedCustomer("zero");
    // A free product: the unreferenced return prices to $0.00.
    await raw.product.update({ where: { id: f.productId }, data: { pricePerUnit: "0.00" } });
    const before = reserved.length;
    const o = await create(f, 1, ret(f.productId, 3, `k-zero-${run}`));
    orderIds.push(o.id);
    expect(await raw.creditNote.count({ where: { customerId: f.customerId } })).toBe(0);
    expect(await raw.orderCreditNote.count({ where: { orderId: o.id } })).toBe(0);
    expect(reserved.length).toBe(before + 1); // reserved ahead of the tx, unused: the accepted burn
    const r = await raw.return.findFirst({ where: { orderId: o.id } });
    expect(r?.creditNoteId ?? null).toBeNull();
  }, 60_000);

  it("DRIVER_CAP through create(): a driver's over-cap return on a new order is held: the order commits, no credit note, no intent", async () => {
    const f = await seedCustomer("drv");
    const drvUser = await raw.user.create({
      data: { email: `drv-${run}@example.test`, username: `drv-${run}`, role: "DRIVER", tenantId },
    });
    userIds.push(drvUser.id);
    const driver = await raw.driver.create({ data: { userId: drvUser.id, tenantId } });
    const route = await raw.route.create({ data: { name: `drv route ${run}`, tenantId } });
    const routeStop = await raw.routeStop.create({
      data: { routeId: route.id, stopNumber: 1, tenantId },
    });
    const routeRun = await raw.routeRun.create({
      data: {
        routeId: route.id,
        driverId: driver.id,
        status: "IN_PROGRESS",
        scheduledDate: new Date(),
        tenantId,
      },
    });
    const stop = await raw.routeRunStop.create({
      data: {
        routeRunId: routeRun.id,
        routeStopId: routeStop.id,
        customerId: f.customerId,
        stopNumber: 1,
        status: "IN_PROGRESS",
        podPhotoUrls: [],
        tenantId,
      },
    });
    const before = reserved.length;
    const user = { ...staff(), sub: drvUser.id, role: "DRIVER" } as JwtPayload;
    const o = await tenantCtx.run(tenantId, () =>
      orders.create(
        {
          customerId: f.customerId,
          items: [{ productId: f.productId, qty: 1 }], // order $10
          routeRunStopId: stop.id,
          inlineReturn: { ...ret(f.productId, 3, `k-drv-${run}`), routeRunStopId: stop.id }, // return $30 > cap
        },
        user,
        { skipAutoMerge: true },
      ),
    );
    orderIds.push(o.id);
    const r = await raw.return.findFirst({ where: { orderId: o.id } });
    expect(r).toMatchObject({ status: "RECEIVED", holdReason: "DRIVER_CAP" });
    expect(await raw.creditNote.count({ where: { customerId: f.customerId } })).toBe(0);
    expect(await raw.orderCreditNote.count({ where: { orderId: o.id } })).toBe(0);
    expect(reserved.length).toBe(before); // a driver create reserves nothing ahead of the tx
    await raw.routeRunStop.deleteMany({ where: { tenantId } });
    await raw.routeRun.deleteMany({ where: { tenantId } });
    await raw.routeStop.deleteMany({ where: { tenantId } });
    await raw.route.deleteMany({ where: { tenantId } });
    await raw.driver.deleteMany({ where: { tenantId } });
  }, 60_000);
});
