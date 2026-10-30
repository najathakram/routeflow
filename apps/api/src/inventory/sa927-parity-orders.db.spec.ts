/**
 * SA-927 PR-A parity (orders): the exact StockMovement rows, counter and average every ORDER stock
 * event leaves, through the REAL OrdersService / OrderTemplatesService over a REAL Postgres. Written
 * green on master; the one-helper change must leave every literal below unchanged.
 *
 * The events are the `notes` of the SALE rows orders/order-stock.ts writes: CREATE, EDIT, CANCEL,
 * UNCANCEL, PROMOTE, DEMOTE and TEMPLATE:<id>. Each `it` runs on fresh products with an average cost
 * (so avgCostAfter / unitCost are real numbers) and a fresh order; the expected numbers come from the
 * business rule (opening 10, sell 3 -> SALE -3, stockAfter 7), not from a printed run.
 *
 * `since` drops the fixture's own rows (opening / seeded booking); an effectiveAt inside the event's
 * window reads "now". `meta` adds what ParityState does not carry: the event name (notes), the unit
 * cost the sale was costed at, and who acted. Ends every event with expectLedgerConsistent (X1).
 *
 * Test tenant only (qa-sa927o-*, assertTestTenant in the fixture). Run: `npm run local:test:db`.
 */
import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { Pool, types } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { OrderTemplatesService } from "../order-templates/order-templates.service";
import { RegulatedVisibilityService } from "../buyer/regulated-visibility.service";
import { buildOrderStockWorld, type OrderStockWorld } from "./testing/order-stock-world";
import { expectLedgerConsistent } from "./testing/ledger-consistency";
import {
  parityState,
  parityWindow,
  type ParityRow,
  type ParityState,
} from "./testing/stock-parity";

/**
 * A reader pool that is correct in any machine timezone. node-pg reads a `timestamp` (no zone) column in
 * the LOCAL zone and sends a Date parameter as local time, but Prisma stores UTC - so on a non-UTC dev
 * PC `parityState`'s "now" window and `since` cutoff are off by the zone offset. Reading as UTC and
 * sending Dates as UTC wall-clock strings makes both honest (a no-op on a UTC runner).
 */
function utcReader(connectionString: string) {
  const pool = new Pool({
    connectionString,
    types: {
      getTypeParser: ((oid: number, format?: string) =>
        oid === 1114
          ? (v: string) => new Date(`${v.replace(" ", "T")}Z`)
          : types.getTypeParser(oid, format as any)) as any,
    },
  });
  return {
    pool,
    query: (text: string, params: unknown[] = []) =>
      pool.query(
        text,
        params.map((v) => (v instanceof Date ? v.toISOString().replace("Z", "") : v)),
      ),
  };
}

interface RowMeta {
  notes: string | null;
  unitCost: number | null;
  performedById: string | null;
}

describeDb("SA-927 parity: order stock events write the same rows, counter and average", () => {
  let w: OrderStockWorld;
  let db: ReturnType<typeof utcReader>;
  let customerId: string;
  let templates: OrderTemplatesService;
  const templateIds: string[] = [];

  beforeAll(async () => {
    w = await buildOrderStockWorld("sa927o", "sa927-parity-orders.db.spec.ts");
    db = utcReader(requireLocalDatabaseUrl());
    // What create()/changeStatus() read beyond the fixture's stubs (as backorder-marker.db.spec.ts wires it).
    Object.assign(w.orders, {
      oversellReader: { read: async () => "off" },
      systemConfig: { get: async () => "0", getAll: async () => ({}) },
      creditNotes: Object.assign(w.orders.creditNotes, {
        settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }),
        previewOrderCreditRelease: async () => [],
        releaseOrderCreditsInTx: async () => undefined,
      }),
    });
    customerId = (await w.prisma.customer.findFirstOrThrow({ where: { tenantId: w.tenantId } })).id;
    templates = new OrderTemplatesService(
      w.prisma,
      (w.orders as any).tenantCtx,
      w.orders,
      { checkAuthorized: async () => ({ blocked: [] }) } as any,
      { sendToCustomer: async () => undefined } as any,
      { get: async () => "0" } as any,
      {
        assertLinesSellable: async () => undefined,
        checkLinesSellable: async () => ({ outcome: "ALLOW", reasons: [] }),
      } as any,
      { read: async () => "off" } as any,
      new RegulatedVisibilityService(w.prisma),
    );
    (templates as any).logger = new Logger("sa927-templates");
  }, 120_000);

  afterAll(async () => {
    const swallow = () => undefined;
    const where = { where: { tenantId: w?.tenantId } };
    if (w) {
      await w.prisma.orderTemplateItem.deleteMany(where).catch(swallow);
      await w.prisma.orderTemplate.deleteMany(where).catch(swallow);
    }
    await w?.cleanup();
    await db?.pool.end();
  }, 120_000);

  /** A product that opened with `opening` pieces, costed at `avg` (AVCO), so avgCostAfter is a number. */
  async function costed(tag: string, opening: number, avg: number): Promise<string> {
    const id = await w.product(tag, opening);
    await w.prisma.product.update({ where: { id }, data: { averageCost: avg } });
    return id;
  }

  /** Everything an event left on one product since `since`, in fold order. */
  async function observe(
    productId: string,
    ctx: { label: string; orderId: string; window: ReturnType<typeof parityWindow>; since: Date },
  ): Promise<{ state: ParityState; meta: RowMeta[] }> {
    const state = await parityState(db, productId, {
      window: ctx.window,
      tokens: { [ctx.orderId]: "<order>" },
      since: ctx.since,
      label: ctx.label,
    });
    const { rows } = await db.query(
      `SELECT notes, "unitCost", "performedById" FROM "StockMovement"
        WHERE "productId" = $1 AND "createdAt" >= $2
        ORDER BY "effectiveAt", "createdAt", id`,
      [productId, ctx.since],
    );
    const meta = rows.map((r: any) => ({
      notes: r.notes,
      unitCost: r.unitCost == null ? null : Number(r.unitCost),
      performedById: r.performedById,
    }));
    return { state, meta };
  }

  /** The SALE row an order event writes: `quantity` signed, counter and average carried on the row. */
  const saleRow = (quantity: number, stockAfter: number, avg: number): ParityRow => ({
    type: "SALE",
    quantity,
    reference: "ORDER:<order>",
    effectiveAt: "now",
    stockAfter,
    avgCostAfter: avg,
  });
  const meta = (notes: string, unitCost: number, actor: string | null): RowMeta => ({
    notes,
    unitCost,
    performedById: actor,
  });

  const since = () => new Date(Date.now() - 2_000);

  it("CREATE: a staff order with A 2 + A 3 (two lines, one product) and B 4 writes ONE row per product", async () => {
    const a = await costed("par-create-a", 10, 2.5);
    const b = await costed("par-create-b", 10, 4);
    const window = parityWindow();
    const from = since();

    const order: any = await w.inTenant(() =>
      w.orders.create(
        {
          customerId,
          items: [
            { productId: a, qty: 2, unitPrice: "5.00" },
            { productId: a, qty: 3, unitPrice: "5.00" },
            { productId: b, qty: 4, unitPrice: "5.00" },
          ],
        },
        w.jwt,
        { skipAutoMerge: true },
      ),
    );

    const ctx = { orderId: order.id, window, since: from };
    const oa = await observe(a, { ...ctx, label: "orders.create.p1" });
    const ob = await observe(b, { ...ctx, label: "orders.create.p2" });
    expect(oa.state).toEqual({ currentStock: 5, averageCost: 2.5, rows: [saleRow(-5, 5, 2.5)] });
    expect(oa.meta).toEqual([meta("CREATE", 2.5, w.jwt.sub)]);
    expect(ob.state).toEqual({ currentStock: 6, averageCost: 4, rows: [saleRow(-4, 6, 4)] });
    expect(ob.meta).toEqual([meta("CREATE", 4, w.jwt.sub)]);
    await expectLedgerConsistent(w.tenantId, [a, b], db);
  }, 120_000);

  it("EDIT: one edit raising A 3 -> 5 and lowering B 4 -> 1 writes SALE -2 on A and SALE +3 on B", async () => {
    const a = await costed("par-edit-a", 10, 2.5);
    const b = await costed("par-edit-b", 10, 4);
    const { order, items } = await w.bookOrder({
      status: "PENDING",
      lines: [
        { productId: a, qty: 3 },
        { productId: b, qty: 4 },
      ],
    });
    expect([await w.stockOf(a), await w.stockOf(b)]).toEqual([7, 6]); // fixture sanity
    const window = parityWindow();
    const from = since();

    await w.inTenant(() =>
      w.orders.updateOrderItems(
        order.id,
        {
          replaceAll: false,
          items: [
            { id: items[0].id, productId: a, qty: 5, unitPrice: "5.00" },
            { id: items[1].id, productId: b, qty: 1, unitPrice: "5.00" },
          ],
        },
        w.jwt,
      ),
    );

    const ctx = { orderId: order.id, window, since: from };
    const oa = await observe(a, { ...ctx, label: "orders.edit.increase.p1" });
    const ob = await observe(b, { ...ctx, label: "orders.edit.decrease.p2" });
    expect(oa.state).toEqual({ currentStock: 5, averageCost: 2.5, rows: [saleRow(-2, 5, 2.5)] });
    expect(oa.meta).toEqual([meta("EDIT", 2.5, w.jwt.sub)]);
    expect(ob.state).toEqual({ currentStock: 9, averageCost: 4, rows: [saleRow(3, 9, 4)] });
    expect(ob.meta).toEqual([meta("EDIT", 4, w.jwt.sub)]);
    await expectLedgerConsistent(w.tenantId, [a, b], db);
  }, 120_000);

  it("CANCEL: an office cancel of a CONFIRMED order of A 3 + B 2 credits both back, one CANCEL row each", async () => {
    const a = await costed("par-cancel-a", 10, 2.5);
    const b = await costed("par-cancel-b", 10, 4);
    const { order } = await w.bookOrder({
      status: "CONFIRMED",
      lines: [
        { productId: a, qty: 3 },
        { productId: b, qty: 2 },
      ],
    });
    expect([await w.stockOf(a), await w.stockOf(b)]).toEqual([7, 8]); // fixture sanity
    const window = parityWindow();
    const from = since();

    await w.inTenant(() => w.orders.changeStatus(order.id, { status: "CANCELLED" }, w.jwt));

    const ctx = { orderId: order.id, window, since: from };
    const oa = await observe(a, { ...ctx, label: "orders.cancel.p1" });
    const ob = await observe(b, { ...ctx, label: "orders.cancel.p2" });
    expect(oa.state).toEqual({ currentStock: 10, averageCost: 2.5, rows: [saleRow(3, 10, 2.5)] });
    expect(oa.meta).toEqual([meta("CANCEL", 2.5, w.jwt.sub)]);
    expect(ob.state).toEqual({ currentStock: 10, averageCost: 4, rows: [saleRow(2, 10, 4)] });
    expect(ob.meta).toEqual([meta("CANCEL", 4, w.jwt.sub)]);
    await expectLedgerConsistent(w.tenantId, [a, b], db);
  }, 120_000);

  it("UNCANCEL: reopening a cancelled order of A 3 re-books it, one UNCANCEL row", async () => {
    const a = await costed("par-uncancel-a", 10, 2.5);
    const { order } = await w.bookOrder({
      status: "CANCELLED",
      cancelled: true,
      lines: [{ productId: a, qty: 3 }],
    });
    expect(await w.stockOf(a)).toBe(10); // fixture sanity: cancelled and credited back
    const window = parityWindow();
    const from = since();

    await w.inTenant(() => w.orders.reopenOrder(order.id));

    const oa = await observe(a, {
      label: "orders.uncancel.p1",
      orderId: order.id,
      window,
      since: from,
    });
    expect(oa.state).toEqual({ currentStock: 7, averageCost: 2.5, rows: [saleRow(-3, 7, 2.5)] });
    expect(oa.meta).toEqual([meta("UNCANCEL", 2.5, null)]);
    await expectLedgerConsistent(w.tenantId, [a], db);
  }, 120_000);

  it("PROMOTE: a DRAFT of A 3 + B 2 moved to PENDING takes the stock, one PROMOTE row each", async () => {
    const a = await costed("par-promote-a", 10, 2.5);
    const b = await costed("par-promote-b", 10, 4);
    const draft: any = await w.inTenant(() =>
      w.orders.create(
        {
          customerId,
          status: "DRAFT",
          items: [
            { productId: a, qty: 3, unitPrice: "5.00" },
            { productId: b, qty: 2, unitPrice: "5.00" },
          ],
        },
        w.jwt,
        { skipAutoMerge: true },
      ),
    );
    expect([await w.stockOf(a), await w.stockOf(b)]).toEqual([10, 10]); // a draft books nothing
    const window = parityWindow();
    const from = since();

    await w.inTenant(() => w.orders.changeStatus(draft.id, { status: "PENDING" }, w.jwt));

    const ctx = { orderId: draft.id, window, since: from };
    const oa = await observe(a, { ...ctx, label: "orders.promote.p1" });
    const ob = await observe(b, { ...ctx, label: "orders.promote.p2" });
    expect(oa.state).toEqual({ currentStock: 7, averageCost: 2.5, rows: [saleRow(-3, 7, 2.5)] });
    expect(oa.meta).toEqual([meta("PROMOTE", 2.5, w.jwt.sub)]);
    expect(ob.state).toEqual({ currentStock: 8, averageCost: 4, rows: [saleRow(-2, 8, 4)] });
    expect(ob.meta).toEqual([meta("PROMOTE", 4, w.jwt.sub)]);
    await expectLedgerConsistent(w.tenantId, [a, b], db);
  }, 120_000);

  it("DEMOTE: a PENDING order of A 3 + B 2 moved back to DRAFT gives the stock back, one DEMOTE row each", async () => {
    const a = await costed("par-demote-a", 10, 2.5);
    const b = await costed("par-demote-b", 10, 4);
    const { order } = await w.bookOrder({
      status: "PENDING",
      lines: [
        { productId: a, qty: 3 },
        { productId: b, qty: 2 },
      ],
    });
    expect([await w.stockOf(a), await w.stockOf(b)]).toEqual([7, 8]); // fixture sanity
    const window = parityWindow();
    const from = since();

    await w.inTenant(() =>
      w.orders.changeStatus(order.id, { status: "DRAFT", reason: "qa: back to draft" }, w.jwt),
    );

    const ctx = { orderId: order.id, window, since: from };
    const oa = await observe(a, { ...ctx, label: "orders.demote.p1" });
    const ob = await observe(b, { ...ctx, label: "orders.demote.p2" });
    expect(oa.state).toEqual({ currentStock: 10, averageCost: 2.5, rows: [saleRow(3, 10, 2.5)] });
    expect(oa.meta).toEqual([meta("DEMOTE", 2.5, w.jwt.sub)]);
    expect(ob.state).toEqual({ currentStock: 10, averageCost: 4, rows: [saleRow(2, 10, 4)] });
    expect(ob.meta).toEqual([meta("DEMOTE", 4, w.jwt.sub)]);
    await expectLedgerConsistent(w.tenantId, [a, b], db);
  }, 120_000);

  it("TEMPLATE: generating an order from a standing order of A 3 + B 2 writes one TEMPLATE:<id> row each", async () => {
    const a = await costed("par-tpl-a", 10, 2.5);
    const b = await costed("par-tpl-b", 10, 4);
    const template = await w.prisma.orderTemplate.create({
      data: {
        tenantId: w.tenantId,
        customerId,
        name: `par-tpl ${randomUUID().slice(0, 8)}`,
        daysOfWeek: [1],
        createdByRole: "OPERATOR",
        itemsEditedByRole: "OPERATOR",
        items: {
          create: [
            { tenantId: w.tenantId, productId: a, qty: 3 },
            { tenantId: w.tenantId, productId: b, qty: 2 },
          ],
        },
      } as any,
    });
    templateIds.push(template.id);
    const window = parityWindow();
    const from = since();

    const order: any = await w.inTenant(() => templates.generateOrderForUser(template.id, w.jwt));

    const ctx = { orderId: order.id, window, since: from };
    const oa = await observe(a, { ...ctx, label: "orders.template.p1" });
    const ob = await observe(b, { ...ctx, label: "orders.template.p2" });
    // The standing-order run has no acting user on its SALE rows (performedById null), staff run or cron.
    expect(oa.state).toEqual({ currentStock: 7, averageCost: 2.5, rows: [saleRow(-3, 7, 2.5)] });
    expect(oa.meta).toEqual([meta(`TEMPLATE:${template.id}`, 2.5, null)]);
    expect(ob.state).toEqual({ currentStock: 8, averageCost: 4, rows: [saleRow(-2, 8, 4)] });
    expect(ob.meta).toEqual([meta(`TEMPLATE:${template.id}`, 4, null)]);
    await expectLedgerConsistent(w.tenantId, [a, b], db);
  }, 120_000);

  it("OVERSELL RACE: two buyers order 3 of the last 5 at once - one wins, one gets INSUFFICIENT_STOCK", async () => {
    const p = await costed("par-race", 5, 2.5);
    const buyers = [] as Array<{ sub: string; jwt: any }>;
    for (const n of [1, 2]) {
      const slug = `${w.slug}-buyer${n}`;
      const user = await w.prisma.user.create({
        data: {
          email: `${slug}@example.invalid`,
          username: slug,
          role: "CUSTOMER",
          tenantId: w.tenantId,
        },
      });
      await w.prisma.customer.create({
        data: {
          userId: user.id,
          businessName: `buyer ${n}`,
          contactName: `buyer ${n}`,
          tenantId: w.tenantId,
        },
      });
      buyers.push({
        sub: user.id,
        jwt: {
          sub: user.id,
          username: slug,
          role: "CUSTOMER",
          status: "ACTIVE",
          forcePasswordChange: false,
          tenantId: w.tenantId,
          tenantSlug: w.slug,
        },
      });
    }
    const window = parityWindow();
    const from = since();

    const results = await Promise.allSettled(
      buyers.map((b) =>
        w.inTenant(() =>
          w.orders.create({ items: [{ productId: p, qty: 3, unitPrice: "5.00" }] }, b.jwt, {
            skipAutoMerge: true,
          }),
        ),
      ),
    );

    const won = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect([won.length, lost.length]).toEqual([1, 1]);
    expect(lost[0].reason.getResponse?.()).toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect(await w.stockOf(p)).toBeGreaterThanOrEqual(0);

    const winner = won[0].value;
    const op = await observe(p, {
      label: "orders.race.p1",
      orderId: winner.id,
      window,
      since: from,
    });
    expect(op.state).toEqual({ currentStock: 2, averageCost: 2.5, rows: [saleRow(-3, 2, 2.5)] });
    const winnerBuyer = buyers[results.findIndex((r) => r.status === "fulfilled")];
    expect(op.meta).toEqual([meta("CREATE", 2.5, winnerBuyer.sub)]);
    await expectLedgerConsistent(w.tenantId, [p], db);
  }, 120_000);
});
