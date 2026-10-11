/**
 * Split payment (counter sale) — real-Postgres pins for what the mocked unit specs cannot prove:
 *  - the tender's invoice read is oldest-first with the id as the tie-break (two invoices of one order created in
 *    the SAME instant, inserted in the opposite order of their ids);
 *  - each leg's payment rows are written with the server-built group id in the payment's own create, and read back
 *    (paymentGroupId travels through `include: { payments: true }`);
 *  - a replay after a partial first attempt records only the missing leg; a held pre-split attempt (ungrouped row)
 *    never double-charges; a split meeting ungrouped rows is a 409 COUNTER_TENDER_CHANGED that writes nothing;
 *  - two concurrent same-key submits take the ONE counter-tender advisory lock (the real one) and record one tender;
 *  - the rows it wrote are exactly what SA-740r2's `assertCashRefundWithinCap` reads (the cash leg's placed amount).
 *
 * The sale's own writer (OrdersService.createSale) and the payment writer (InvoicesService.recordPayment) are stand-ins
 * that write the same rows (the real ones need the invoice pipeline); everything else is the real CounterSaleService on
 * a real PrismaService. NOT RUN by the authoring lane (no Postgres): the DB lane runs it (`npm run local:test:db`,
 * test tenant only, collected only by jest.db.config.js).
 */
jest.mock("../../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { CounterSaleService } from "./counter-sale.service";
import { legGroupId } from "./counter-tender-row";
import { pickupTenderGroupId } from "./pickup-tender-group";
import { assertCashRefundWithinCap } from "../../returns/cash-refund-cap";
import type { JwtPayload } from "../../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

describeDb("split payment — counter sale tender on real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: CounterSaleService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-cs-split-${run}`, "counter-sale-split-tender.db.spec.ts");
  let tenantId = "";
  let operatorId = "";
  let walkInId = "";
  let productId = "";
  const userIds: string[] = [];
  const orderIds: string[] = [];
  let n = 0;

  /** Sales this run has rung: key -> order id (the stand-in createSale's idempotency). */
  const salesByKey = new Map<string, string>();
  /** Invoice totals of the NEXT new sale, in INSERTION order, each with the explicit id it is given. */
  let nextInvoices: Array<{ id: string; total: number }> = [];
  /** Make the Nth recordPayment of the current ring throw (1-based), to leave a partial first attempt. */
  let failRecordAt: number | null = null;
  let recordCalls = 0;
  let queue: Promise<unknown> = Promise.resolve(); // serialises the stand-in createSale like create()'s own key guard

  const staff = (): JwtPayload =>
    ({
      sub: operatorId,
      username: "operator",
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    }) as JwtPayload;

  const ordersStandIn = {
    findReplayCandidateByKey: async (key: string) => {
      const id = salesByKey.get(key);
      return id ? { id, orderNumber: `T${run}`, counterSale: true, status: "DELIVERED" } : null;
    },
    createSale: (dto: unknown, _user: unknown, sale: any) => {
      const step = queue.then(async () => {
        const key = (dto as { idempotencyKey?: string }).idempotencyKey ?? randomUUID();
        const existing = salesByKey.get(key);
        if (existing) {
          sale?.onReplay?.({ id: existing, counterSale: true });
          return { id: "unused", orderId: existing };
        }
        const total = nextInvoices.reduce((s, i) => s + i.total, 0);
        await sale?.beforeWrite?.({ total });
        n += 1;
        const order = await raw.order.create({
          data: {
            customerId: walkInId,
            tenantId,
            counterSale: true,
            status: "DELIVERED",
            orderNumber: `S${run}-${n}`,
            total,
          },
        });
        orderIds.push(order.id);
        const sameInstant = new Date();
        for (const [idx, inv] of nextInvoices.entries()) {
          await raw.invoice.create({
            data: {
              id: inv.id,
              invoiceNumber: `INV-${run}-${n}-${String.fromCharCode(97 + idx)}`, // a, b: unique per order, never id-derived
              customerId: walkInId,
              orderId: order.id,
              tenantId,
              status: "SENT",
              subtotal: inv.total,
              total: inv.total,
              createdAt: sameInstant,
            },
          });
        }
        salesByKey.set(key, order.id);
        return { id: nextInvoices[0].id, orderId: order.id };
      });
      queue = step.catch(() => undefined);
      return step;
    },
  };

  const invoicesStandIn = {
    /** Writes the row recordPayment writes, the group id in the same create. */
    recordPayment: async (invoiceId: string, dto: any, opts?: { paymentGroupId?: string }) => {
      recordCalls += 1;
      if (failRecordAt === recordCalls) throw new Error("simulated recordPayment failure");
      const created = await raw.invoicePayment.create({
        data: {
          invoiceId,
          tenantId,
          amount: dto.amount,
          method: dto.method,
          reference: dto.reference,
          status: "PAID",
          paidAt: new Date(),
          paymentGroupId: opts?.paymentGroupId,
        },
      });
      return { id: invoiceId, createdPaymentId: created.id };
    },
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    tenantId = (await raw.tenant.create({ data: { slug, name: `CS split ${slug}` } })).id;
    const mkUser = async (role: "OPERATOR" | "CUSTOMER", tag: string) => {
      const u = await raw.user.create({
        data: {
          email: `${tag}-${run}@example.test`,
          username: `${tag}-${run}`,
          role,
          tenantId,
        },
      });
      userIds.push(u.id);
      return u.id;
    };
    operatorId = await mkUser("OPERATOR", "op");
    walkInId = (
      await raw.customer.create({
        data: {
          userId: await mkUser("CUSTOMER", "walkin"),
          businessName: "Walk-in",
          contactName: "Tester",
          isWalkIn: true,
          tenantId,
        },
      })
    ).id;
    productId = (
      await raw.product.create({
        data: {
          name: `split ${run}`,
          unit: "each",
          pricePerUnit: "10.00",
          currentStock: 100,
          tenantId,
        },
      })
    ).id;
    service = new CounterSaleService(
      ordersStandIn as never,
      invoicesStandIn as never,
      { getOrCreateWalkIn: async () => walkInId } as never,
      prisma,
      { get: async () => ({ counter: "always", methods: ["PICKUP"], consistent: true }) } as never,
      { log: async () => undefined } as never,
    );
  }, 120_000);

  afterAll(async () => {
    const invoiceIds = (
      await raw.invoice.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } })
    ).map((i) => i.id);
    await raw.return.deleteMany({ where: { orderId: { in: orderIds } } });
    await raw.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await raw.order.deleteMany({ where: { id: { in: orderIds } } });
    await raw.product.deleteMany({ where: { id: productId } });
    await raw.customer.deleteMany({ where: { id: walkInId } });
    await raw.user.deleteMany({ where: { id: { in: userIds } } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  const ring = (body: Record<string, unknown>, key: string) =>
    tenantCtx.run(tenantId, () =>
      service.ring(
        { walkIn: true, items: [{ productId, qty: 1 }], ...body } as never,
        staff(),
        key,
      ),
    );
  /** A rung sale with NO tender yet (what a first attempt that died before its payment step leaves). */
  const seedSale = async (key: string): Promise<string> => {
    await ordersStandIn.createSale({ idempotencyKey: key }, null, undefined);
    return salesByKey.get(key)!;
  };
  const rowsOf = async (orderId: string) =>
    (
      await raw.invoicePayment.findMany({
        where: { invoice: { orderId } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          invoiceId: true,
          amount: true,
          method: true,
          paymentGroupId: true,
          id: true,
        },
      })
    ).map((r) => ({ ...r, amount: Number(r.amount) }));
  const sum = (rows: Array<{ amount: number }>) =>
    Math.round(rows.reduce((s, r) => s + r.amount * 100, 0)) / 100;

  const split = [
    { method: "CARD", amount: 30 },
    { method: "CASH", amount: 50 },
  ];

  /** Seeds `nextInvoices` for a 50 + 20 sale: A (50) sorts first by id but is inserted SECOND. */
  const twoInvoices = () => {
    const a = `00000000-0000-4000-8000-${"a".repeat(8)}${randomUUID().slice(0, 4)}`;
    const b = `00000000-0000-4000-8000-${"b".repeat(8)}${randomUUID().slice(0, 4)}`;
    nextInvoices = [
      { id: b, total: 20 },
      { id: a, total: 50 },
    ];
    return { a, b };
  };

  it("a split over two invoices created in the same instant is tendered in id order, groups stored, change 10", async () => {
    const { a, b } = twoInvoices();
    const key = `split-${randomUUID()}`;
    const r = await ring({ payments: split }, key);
    const orderId = salesByKey.get(key)!;
    const rows = await rowsOf(orderId);
    expect(rows.map((x) => [x.invoiceId, x.method, x.amount, x.paymentGroupId])).toEqual(
      expect.arrayContaining([
        [a, "CREDIT_CARD", 30, legGroupId(orderId, 0)],
        [a, "CASH", 20, legGroupId(orderId, 1)],
        [b, "CASH", 20, legGroupId(orderId, 1)],
      ]),
    );
    expect(rows).toHaveLength(3);
    expect(r).toMatchObject({ total: 70, paid: 70, balanceDue: 0, change: 10, method: "CARD" });
    expect(r.invoiceId).toBe(a);
    expect(r.payments).toEqual([
      {
        method: "CARD",
        amount: 30,
        paymentIds: [rows.find((x) => x.method === "CREDIT_CARD")!.id],
      },
      { method: "CASH", amount: 40, paymentIds: expect.arrayContaining([expect.any(String)]) },
    ]);
  });

  it("a partial first attempt (card recorded, cash not) is finished by the replay: only the cash is recorded", async () => {
    twoInvoices();
    const key = `split-${randomUUID()}`;
    recordCalls = 0;
    failRecordAt = 2; // the card (1st call) lands, the cash leg's first row fails
    const first = await ring({ payments: split }, key);
    failRecordAt = null;
    expect(first).toMatchObject({
      paymentRecorded: false,
      paymentErrorCode: "COUNTER_PAYMENT_NOT_RECORDED",
    });
    const orderId = salesByKey.get(key)!;
    expect(await rowsOf(orderId)).toHaveLength(1);

    const again = await ring({ payments: split }, key);
    const rows = await rowsOf(orderId);
    expect(again).toMatchObject({ replayed: true, paid: 70, change: 10, paymentRecorded: true });
    expect(rows.filter((x) => x.method === "CREDIT_CARD")).toHaveLength(1);
    expect(sum(rows.filter((x) => x.method === "CASH"))).toBe(40);
    // and a third identical replay changes nothing
    await ring({ payments: split }, key);
    expect(await rowsOf(orderId)).toHaveLength(rows.length);
  });

  const refusedReplay = async (body: unknown, key: string) => {
    const err: any = await ring(body as never, key).then(
      () => null,
      (e) => e,
    );
    expect(err?.getStatus?.()).toBe(409);
    expect(err.getResponse().code).toBe("COUNTER_TENDER_CHANGED");
  };
  const storedTendered = async (orderId: string) =>
    (await raw.order.findFirstOrThrow({ where: { id: orderId } })).counterCashTendered;

  it("an interrupted split (card recorded, cash missing, 50 handed) replayed with a DIFFERENT cash amount is 409 and changes nothing", async () => {
    twoInvoices();
    const key = `split-${randomUUID()}`;
    recordCalls = 0;
    failRecordAt = 2; // the card lands, the cash leg's first row fails
    await ring({ payments: split }, key);
    failRecordAt = null;
    const orderId = salesByKey.get(key)!;
    expect(await rowsOf(orderId)).toHaveLength(1);
    expect(Number(await storedTendered(orderId))).toBe(50);

    await refusedReplay(
      {
        payments: [
          { method: "CARD", amount: 30 },
          { method: "CASH", amount: 60 },
        ],
      },
      key,
    );
    expect(await rowsOf(orderId)).toHaveLength(1);
    expect(Number(await storedTendered(orderId))).toBe(50);
    // the same body still finishes it
    const done = await ring({ payments: split }, key);
    expect(done).toMatchObject({ paid: 70, change: 10, paymentRecorded: true });
  });

  it("the legs replayed in another ORDER are 409 (the leg index is the stored identity) and write nothing", async () => {
    twoInvoices();
    const key = `split-${randomUUID()}`;
    await ring({ payments: split }, key);
    const orderId = salesByKey.get(key)!;
    const before = await rowsOf(orderId);
    await refusedReplay({ payments: [...split].reverse() }, key);
    expect(await rowsOf(orderId)).toHaveLength(before.length);
    expect(Number(await storedTendered(orderId))).toBe(50);
  });

  it("a held pre-split attempt (an ungrouped CARD row) replayed as the old {payment} never double-charges", async () => {
    nextInvoices = [{ id: randomUUID(), total: 70 }];
    const key = `old-${randomUUID()}`;
    const orderId = await seedSale(key);
    const invoice = await raw.invoice.findFirstOrThrow({ where: { orderId } });
    await raw.invoicePayment.create({
      data: {
        invoiceId: invoice.id,
        tenantId,
        amount: 70,
        method: "CREDIT_CARD",
        status: "PAID",
        paidAt: new Date(),
      },
    });
    const r = await ring({ payment: { method: "CARD" } }, key);
    expect(r).toMatchObject({ replayed: true, paid: 70, paymentRecorded: true, method: "CARD" });
    expect(await rowsOf(orderId)).toHaveLength(1);
  });

  it("a split meeting that ungrouped row is 409 COUNTER_TENDER_CHANGED and writes nothing", async () => {
    nextInvoices = [{ id: randomUUID(), total: 70 }];
    const key = `old2-${randomUUID()}`;
    const orderId = await seedSale(key);
    const invoice = await raw.invoice.findFirstOrThrow({ where: { orderId } });
    await raw.invoicePayment.create({
      data: {
        invoiceId: invoice.id,
        tenantId,
        amount: 30,
        method: "CREDIT_CARD",
        status: "PAID",
        paidAt: new Date(),
      },
    });
    const err: any = await ring({ payments: split }, key).then(
      () => null,
      (e) => e,
    );
    expect(err?.getStatus?.()).toBe(409);
    expect(err.getResponse().code).toBe("COUNTER_TENDER_CHANGED");
    expect(await rowsOf(orderId)).toHaveLength(1);
  });

  // A1: with no leg-grouped row, only the ONE predicate's ungrouped tender is the sale's (readStoredTender's legacy branch).
  describe("a sale with no leg-grouped row: a hand-over's cash and office rows are not its tender", () => {
    const addRow = async (
      orderId: string,
      p: { amount: number; method: string; group?: string | null; checkStatus?: string },
    ) => {
      const invoice = await raw.invoice.findFirstOrThrow({ where: { orderId } });
      return raw.invoicePayment.create({
        data: {
          invoiceId: invoice.id,
          tenantId,
          amount: p.amount,
          method: p.method as never,
          status: "PAID",
          paidAt: new Date(),
          paymentGroupId: p.group ?? null,
          ...(p.checkStatus ? { checkStatus: p.checkStatus as never } : {}),
        },
      });
    };

    it("an ON_ACCOUNT sale, then the pickup hand-over's cash: by-key still reads ON_ACCOUNT (the named-customer replay is pinned in the unit spec)", async () => {
      nextInvoices = [{ id: randomUUID(), total: 37.25 }];
      const key = `onacct-${randomUUID()}`;
      const orderId = await seedSale(key);
      const handOver = await addRow(orderId, {
        amount: 37.25,
        method: "CASH",
        group: pickupTenderGroupId(orderId),
      });
      const byKey = await tenantCtx.run(tenantId, () => service.byKey(key));
      expect(byKey.method).toBe("ON_ACCOUNT");
      expect(byKey.paymentId).toBeUndefined();
      expect(byKey.payments ?? []).toEqual([]);
      expect(byKey.paymentId).not.toBe(handOver.id);
      expect(await rowsOf(orderId)).toHaveLength(1);
    });

    it("a legacy CASH sale, then an office ACH row on the invoice: the same-key retry is a replay, never 409", async () => {
      nextInvoices = [{ id: randomUUID(), total: 37.25 }];
      const key = `legacy-${randomUUID()}`;
      const orderId = await seedSale(key);
      const till = await addRow(orderId, { amount: 37.25, method: "CASH" });
      await raw.order.update({ where: { id: orderId }, data: { counterCashTendered: 50 } });
      await addRow(orderId, { amount: 5, method: "ACH" });
      await addRow(orderId, { amount: 7, method: "CHECK", checkStatus: "DEPOSITED" });
      const r = await ring({ payment: { method: "CASH", amount: 50 } }, key);
      expect(r).toMatchObject({ replayed: true, method: "CASH", paymentId: till.id });
      expect(r.payments).toEqual([{ method: "CASH", amount: 37.25, paymentIds: [till.id] }]);
      expect(await rowsOf(orderId)).toHaveLength(3);
    });
  });

  it("two concurrent same-key submits take the real counter-tender lock and record ONE tender", async () => {
    nextInvoices = [{ id: randomUUID(), total: 70 }];
    const key = `race-${randomUUID()}`;
    const [x, y] = await Promise.all([
      ring({ payments: split }, key),
      ring({ payments: split }, key),
    ]);
    const orderId = salesByKey.get(key)!;
    const rows = await rowsOf(orderId);
    expect(rows.filter((r) => r.method === "CREDIT_CARD")).toHaveLength(1);
    expect(sum(rows)).toBe(70);
    expect(x.paymentRecorded).toBe(true);
    expect(y.paymentRecorded).toBe(true);
  });

  describe("the cash refund cap reads the split's rows (SA-740r2's assertCashRefundWithinCap)", () => {
    const cap = (orderId: string, amount: number) =>
      assertCashRefundWithinCap(raw, {
        returnId: randomUUID(),
        tender: "CASH",
        perOrder: new Map([[orderId, amount]]),
      }).then(
        () => null,
        (e: any) => ({ status: e.getStatus(), code: e.getResponse().code }),
      );

    it("card 30 + cash 50 on 70: the cash applied is 40 (change excluded); 40 fits, 40.01 is 409", async () => {
      nextInvoices = [{ id: randomUUID(), total: 70 }];
      const key = `cap-${randomUUID()}`;
      await ring({ payments: split }, key);
      const orderId = salesByKey.get(key)!;
      expect(await cap(orderId, 40)).toBeNull();
      expect(await cap(orderId, 40.01)).toEqual({ status: 409, code: "REFUND_EXCEEDS_CASH_PAID" });
    });

    it("an earlier refunded return on the sale (cash 40, 20 refunded) leaves room for 20, not 20.01", async () => {
      nextInvoices = [{ id: randomUUID(), total: 70 }];
      const key = `cap2-${randomUUID()}`;
      await ring({ payments: split }, key);
      const orderId = salesByKey.get(key)!;
      await raw.return.create({
        data: {
          returnNumber: `R${run}-${n}`,
          orderId,
          customerId: walkInId,
          tenantId,
          reason: "DAMAGED",
          kind: "STANDARD",
          status: "REFUNDED",
          refundMethod: "EXTERNAL_REFUND",
          refundAmount: 20,
          refundedAt: new Date(),
        },
      });
      expect(await cap(orderId, 20)).toBeNull();
      expect(await cap(orderId, 20.01)).toEqual({ status: 409, code: "REFUND_EXCEEDS_CASH_PAID" });
    });
  });
});
