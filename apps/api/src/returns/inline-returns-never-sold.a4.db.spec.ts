/**
 * SA-1060 amendment A-4 (what "never sold" reads): real-Postgres rows NS-1 to NS-11 and NS-12.
 *
 * "Never sold" asks one question of the database: does this customer have a live invoice line of the product, ever, with or
 * without an order? Live = every status except DRAFT and VOID, plus a DRAFT of a delivered order (ACCRUAL_REVENUE_STATUSES, so
 * a written-off sale counts: the goods left and the tax was charged). A mocked client cannot prove the read: it accepts
 * `where` keys that do not exist and answers whatever it is told, so every row here runs the real quote against real rows.
 *
 * The screen (POST /returns/inline/quote) and the note (the edit's dry run) must give one answer. On an UNDELIVERED order edit
 * the revert turns the order's own SENT invoice into a DRAFT of an undelivered order before the capture; the quote names the
 * order it is editing (`editingOrderId`) and prices against the same post-revert set.
 *
 * Fixtures: 10 at $10.00 with an 8% tenant tax rate. Return 3 of them: a sold chunk is $30.00 + $2.40 tax = $32.40; a
 * never-sold chunk is $30.00 and no tax, and is not added to stock.
 *
 * Run via `npm run local:test:db` (compose Postgres) - collected only by jest.db.config.js.
 */
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
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { InlineReturnsService } from "./inline-returns.service";
import { carrierEditGuard, resyncsInPlace } from "../orders/order-carrier-guard";
import { SHIP_STATE_REOPENED } from "../orders/ship-state-markers";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("SA-1060 A-4 - what never sold reads, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let quoteService: InlineReturnsQuoteService;
  let svc: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-sa1060a4-${run}`, "inline-returns-never-sold.a4.db.spec.ts");
  let tenantId = "";
  const orderIds: string[] = [];
  const customerIds: string[] = [];
  const productIds: string[] = [];
  const userIds: string[] = [];
  const invoiceIds: string[] = [];
  let seq = 0;

  /** A ship-mode feature config: whether an order is "with the carrier" is then decided by the order's own fields. */
  const featureConfig = { getEffectiveMode: async () => "ship" };

  let operatorId = "";
  const staff: () => JwtPayload = () => ({
    sub: operatorId,
    username: "operator",
    role: "OPERATOR" as any,
    status: "ACTIVE" as any,
    forcePasswordChange: false,
    tenantId,
    tenantSlug: slug,
  });

  type World = { customerId: string; productId: string; carryId: string };

  async function newCustomer(tag: string) {
    const u = await raw.user.create({
      data: {
        email: `${tag}-${run}-${++seq}@example.test`,
        username: `${tag}-${run}-${seq}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    userIds.push(u.id);
    const c = await raw.customer.create({
      data: { userId: u.id, businessName: `${tag} co`, contactName: "A4 Tester", tenantId },
    });
    customerIds.push(c.id);
    return c.id;
  }

  /** A customer, a product, and a DELIVERED order with no invoice that carries a capture. */
  async function world(tag: string): Promise<World> {
    const product = await raw.product.create({
      data: {
        name: `${tag} product ${run} ${++seq}`,
        unit: "each",
        pricePerUnit: "10.00",
        tenantId,
      },
    });
    productIds.push(product.id);
    const customerId = await newCustomer(tag);
    const carry = await raw.order.create({
      data: { customerId, tenantId, status: "DELIVERED", subtotal: "0.00", total: "0.00" },
    });
    orderIds.push(carry.id);
    return { customerId, productId: product.id, carryId: carry.id };
  }

  /**
   * One sale: an optional order, an invoice of 10 at $10.00 with 8% tax (qty overridable), one line of the product.
   * `orderId: null` is an invoice with no order (estimate convert, import, a manual or a duplicated invoice).
   */
  async function sale(
    w: { customerId: string; productId: string },
    o: {
      status: string;
      order?: null | {
        status?: string;
        fulfillPath?: string;
        shippedAt?: Date;
        reopened?: boolean;
      };
      qty?: number;
      daysAgo?: number;
      depositPercent?: number;
      customerId?: string;
    },
  ) {
    const customerId = o.customerId ?? w.customerId;
    let orderId: string | null = null;
    if (o.order !== null) {
      const spec = o.order ?? {};
      const order = await raw.order.create({
        data: {
          customerId,
          tenantId,
          status: (spec.status ?? "DELIVERED") as any,
          subtotal: "100.00",
          total: "108.00",
          ...(spec.fulfillPath ? { fulfillPath: spec.fulfillPath as any } : {}),
          ...(spec.shippedAt ? { shippedAt: spec.shippedAt } : {}),
        },
      });
      orderIds.push(order.id);
      orderId = order.id;
      if (spec.reopened) {
        await raw.orderRevision.create({
          data: {
            tenantId,
            orderId,
            revisionNumber: 1,
            source: SHIP_STATE_REOPENED,
            snapshot: {},
          },
        });
      }
    }
    const qty = o.qty ?? 10;
    const subtotal = qty * 10;
    const tax = Math.round(subtotal * 8) / 100;
    const invoice = await raw.invoice.create({
      data: {
        tenantId,
        customerId,
        orderId,
        invoiceNumber: `INV-A4-${run}-${++seq}`,
        status: o.status as any,
        subtotal: subtotal.toFixed(2),
        taxAmount: tax.toFixed(2),
        total: (subtotal + tax).toFixed(2),
        issueDate: new Date(Date.now() - (o.daysAgo ?? 10) * 86_400_000),
        ...(o.depositPercent != null ? { depositPercent: o.depositPercent.toFixed(2) } : {}),
      },
    });
    invoiceIds.push(invoice.id);
    await raw.invoiceItem.create({
      data: {
        tenantId,
        invoiceId: invoice.id,
        productId: w.productId,
        description: "Widget",
        qty,
        unitPrice: "10.00",
        subtotal: subtotal.toFixed(2),
        taxRate: "0.08",
      },
    });
    return { invoiceId: invoice.id, orderId };
  }

  /** POST /returns/inline/quote, as the screen calls it. `editingOrderId` rides along when the order edit names it. */
  const quote = (w: World, pieces: number, editingOrderId?: string, customerId?: string) =>
    tenantCtx.run(tenantId, () =>
      quoteService.quote(
        {
          customerId: customerId ?? w.customerId,
          items: [{ productId: w.productId, boxes: 0, pieces }],
          ...(editingOrderId ? { editingOrderId } : {}),
        } as any,
        staff(),
      ),
    );

  /** What the screen shows for the one chunk: the money, the tax, whether it is flagged never sold. */
  const figure = (q: any) => ({
    total: q.total,
    tax: q.taxAmount,
    chunks: q.chunks.length,
    neverSold: q.chunks.map((c: any) => c.neverSold),
  });

  /**
   * What the edit's dry run (the note) prices, built from the edit's own routing: the carrier guard, `resyncsInPlace`, and
   * `preflightCapture` with `revertOrderId` exactly when the revert runs (orders.service.ts: `!postDeliveryEdit`).
   */
  async function note(w: World, editOrderId: string, pieces: number) {
    return tenantCtx.run(tenantId, async () => {
      const db = prisma.forTenant();
      const order = await db.order.findFirstOrThrow({ where: { id: editOrderId } });
      const guard = await carrierEditGuard({ featureConfig, prisma } as any, order as any);
      const willRevert = !resyncsInPlace(order.status, guard);
      const dto = {
        customerId: w.customerId,
        orderId: editOrderId,
        items: [{ productId: w.productId, boxes: 0, pieces }],
      } as any;
      const total = await svc.preflightCapture(
        dto,
        staff(),
        { routeRunId: null },
        willRevert ? { revertOrderId: editOrderId } : {},
      );
      return { total, willRevert };
    });
  }

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
    // the 4th argument is the optional feature-config reader A-4's quote uses to ask whether an order is with the carrier
    quoteService = new (InlineReturnsQuoteService as any)(
      prisma,
      systemConfig,
      undefined,
      featureConfig,
    );
    const creditNotes = Object.assign(Object.create(CreditNotesService.prototype), {
      prisma,
      gateway: { emitCreditNoteCreated: jest.fn() },
      ledger,
      commissionEngine: {},
      numbering,
      logger: new Logger(CreditNotesService.name),
    });
    svc = Object.assign(Object.create(InlineReturnsService.prototype), {
      prisma,
      gateway: { emitCreditNoteCreated: jest.fn() },
      ledger,
      creditNotes,
      numbering,
      addonService: { hasAddon: async () => true },
      quoteService,
      idempotency,
    });

    tenantId = (await raw.tenant.create({ data: { slug, name: `A4 ${slug}` } })).id;
    const op = await raw.user.create({
      data: {
        email: `a4-op-${run}@example.test`,
        username: `a4-op-${run}`,
        role: "OPERATOR",
        tenantId,
      },
    });
    userIds.push(op.id);
    operatorId = op.id;
    await raw.systemConfig.create({ data: { tenantId, key: "settings.taxRate", value: "8" } });
  }, 120_000);

  afterAll(async () => {
    for (const orderId of orderIds) {
      await raw.orderCreditNote.deleteMany({ where: { orderId } });
      await raw.returnItem.deleteMany({ where: { return: { orderId } } });
      await raw.return.deleteMany({ where: { orderId } });
    }
    await raw.creditNote.deleteMany({ where: { tenantId } });
    await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
    await raw.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await raw.orderRevision.deleteMany({ where: { orderId: { in: orderIds } } });
    await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await raw.order.deleteMany({ where: { id: { in: orderIds } } });
    await raw.customer.deleteMany({ where: { id: { in: customerIds } } });
    await raw.user.deleteMany({ where: { id: { in: userIds } } });
    await raw.product.deleteMany({ where: { id: { in: productIds } } });
    await raw.systemConfig.deleteMany({ where: { tenantId } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
    await raw.$disconnect();
    await pool.end();
  }, 120_000);

  const SOLD = { total: 32.4, tax: 2.4, chunks: 1, neverSold: [false] };
  const NEVER = { total: 30, tax: 0, chunks: 1, neverSold: [true] };

  // ─── NS-1 / NS-2: a sale with no order is a sale ─────────────────────────────────

  it("NS-1: a paid converted invoice with no order, 10 at $10 with 8% tax, return 3 -> $32.40, tax 2.40, Sold before", async () => {
    const w = await world("ns1");
    await sale(w, { status: "PAID", order: null });
    expect(figure(await quote(w, 3))).toEqual(SOLD);
  }, 30_000);

  it("NS-1b: the same return, captured, restocks (a movement of 3), because the goods were sold to this customer", async () => {
    const w = await world("ns1b");
    await sale(w, { status: "PAID", order: null });
    const ret = await tenantCtx.run(tenantId, () =>
      svc.capture(
        {
          customerId: w.customerId,
          orderId: w.carryId,
          items: [{ productId: w.productId, qty: 3 }],
          returnKey: `ns1b-${run}`,
        },
        staff(),
      ),
    );
    const items = await raw.returnItem.findMany({ where: { returnId: ret.id } });
    expect(items.map((i) => i.restock)).toEqual([true]);
    expect(
      await raw.stockMovement.count({ where: { productId: w.productId, type: "RETURN" } }),
    ).toBe(1);
  }, 30_000);

  it.each([
    ["an imported invoice", "PAID"],
    ["a manual invoice", "SENT"],
    ["a sent duplicate", "SENT"],
  ])(
    "NS-2: the product's only sale is %s with no order -> Sold before",
    async (_label, status) => {
      const w = await world("ns2");
      await sale(w, { status, order: null });
      expect(figure(await quote(w, 3))).toEqual(SOLD);
    },
    30_000,
  );

  // ─── NS-3 / NS-4: a written-off invoice is a sale ────────────────────────────────

  it("NS-3: the only sale is WRITTEN_OFF, with an order -> Sold before", async () => {
    const w = await world("ns3");
    await sale(w, { status: "WRITTEN_OFF" });
    expect(figure(await quote(w, 3))).toEqual(SOLD);
  }, 30_000);

  it("NS-4: the only sale is WRITTEN_OFF, with no order -> Sold before", async () => {
    const w = await world("ns4");
    await sale(w, { status: "WRITTEN_OFF", order: null });
    expect(figure(await quote(w, 3))).toEqual(SOLD);
  }, 30_000);

  // ─── NS-5 / NS-6: what is not a sale, and the delivered draft that is ────────────

  it.each([
    ["a VOID", { status: "VOID" }],
    ["a DRAFT with no order", { status: "DRAFT", order: null }],
    ["a DRAFT of an undelivered order", { status: "DRAFT", order: { status: "PENDING" } }],
    ["a 0-qty line", { status: "PAID", qty: 0 }],
  ] as const)(
    "NS-5 (guard): the only line is %s -> Never sold",
    async (_label, spec) => {
      const w = await world("ns5");
      await sale(w, spec as any);
      expect(figure(await quote(w, 3))).toEqual(NEVER);
    },
    30_000,
  );

  it("NS-5 (guard): the only sale is another customer's -> Never sold", async () => {
    const w = await world("ns5o");
    const other = await newCustomer("ns5-other");
    await sale(w, { status: "PAID", customerId: other });
    expect(figure(await quote(w, 3))).toEqual(NEVER);
  }, 30_000);

  it("NS-6 (guard): the only sale is a DRAFT of a delivered order -> Sold before", async () => {
    const w = await world("ns6");
    await sale(w, { status: "DRAFT", order: { status: "DELIVERED" }, daysAgo: 120 });
    expect(figure(await quote(w, 3))).toEqual(SOLD);
  }, 30_000);

  // ─── NS-7 .. NS-10: the screen reads what the note reads ─────────────────────────

  /** An undelivered order being edited, whose own unpaid SENT invoice is the customer's only sale of the product. */
  async function editedOrder(tag: string, order: Record<string, unknown> = {}, inv = {}) {
    const w = await world(tag);
    const s = await sale(w, { status: "SENT", order: { status: "CONFIRMED", ...order }, ...inv });
    return { w, editId: s.orderId! };
  }

  it("NS-7: undelivered order edit, the only sale is this order's unpaid SENT invoice: the screen and the note both say $30.00, Never sold", async () => {
    const { w, editId } = await editedOrder("ns7");
    expect(figure(await quote(w, 3, editId))).toEqual(NEVER);
  }, 30_000);

  it("NS-7b (guard): the same edit's note (the dry run after the revert) says $30.00 on its own", async () => {
    const { w, editId } = await editedOrder("ns7b");
    expect(await note(w, editId, 3)).toEqual({ total: 30, willRevert: true });
  }, 30_000);

  it("NS-8 (guard): plus a paid sale on another invoice -> both Sold before", async () => {
    const { w, editId } = await editedOrder("ns8");
    await sale(w, { status: "PAID" });
    expect(figure(await quote(w, 3, editId))).toEqual(SOLD);
    expect((await note(w, editId, 3)).total).toBe(32.4);
  }, 30_000);

  it("NS-9 (guard): NS-7 on a deposit mirror, which stays SENT -> both count it", async () => {
    const { w, editId } = await editedOrder("ns9", {}, { depositPercent: 50 });
    expect(figure(await quote(w, 3, editId))).toEqual(SOLD);
    expect(await note(w, editId, 3)).toEqual({ total: 32.4, willRevert: true });
  }, 30_000);

  it("NS-10 (guard): NS-7 on an OUT_FOR_DELIVERY order -> nothing reverts, both count it", async () => {
    const { w, editId } = await editedOrder("ns10a", { status: "OUT_FOR_DELIVERY" });
    expect(figure(await quote(w, 3, editId))).toEqual(SOLD);
    expect(await note(w, editId, 3)).toEqual({ total: 32.4, willRevert: false });
  }, 30_000);

  it("NS-10 (guard): NS-7 on a with-carrier order -> nothing reverts, both count it", async () => {
    const { w, editId } = await editedOrder("ns10b", {
      status: "CONFIRMED",
      fulfillPath: "SHIP",
      shippedAt: new Date(),
      reopened: true,
    });
    expect(figure(await quote(w, 3, editId))).toEqual(SOLD);
    expect(await note(w, editId, 3)).toEqual({ total: 32.4, willRevert: false });
  }, 30_000);

  // ─── NS-11 / NS-12 ───────────────────────────────────────────────────────────────

  it("NS-11: editingOrderId of another customer's order -> 400 SOURCE_SALE_INVALID", async () => {
    const mine = await world("ns11");
    const other = await world("ns11o");
    const theirs = await sale(other, { status: "SENT", order: { status: "CONFIRMED" } });
    await expect(quote(mine, 3, theirs.orderId!)).rejects.toMatchObject({
      response: { code: "SOURCE_SALE_INVALID" },
      status: 400,
    });
  }, 30_000);

  it("NS-11b: an order id that does not exist is refused the same way", async () => {
    const w = await world("ns11b");
    await expect(quote(w, 3, randomUUID())).rejects.toMatchObject({
      response: { code: "SOURCE_SALE_INVALID" },
      status: 400,
    });
  }, 30_000);

  it("NS-12 (guard): NS-7's sale with no editingOrderId (New order, the counter) -> unchanged, the SENT invoice counts: $32.40", async () => {
    const { w } = await editedOrder("ns12");
    expect(figure(await quote(w, 3))).toEqual(SOLD);
  }, 30_000);
});
