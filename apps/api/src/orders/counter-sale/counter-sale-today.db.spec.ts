/**
 * POS-7b-1 — real-Postgres pin for GET /orders/counter-sale/today: the page query and the three grouped
 * summary queries (order.aggregate, invoicePayment.groupBy, return.groupBy) return exactly the figures the same
 * fixtures give when folded in plain JS (integer cents), across the tenant-zone day window (to the millisecond:
 * `Order.createdAt` is timestamp(3) UTC), two tenants, a non-counter order, voided and cancelled sales, ignored
 * DRAFT / PENDING / VOID payments, a refund made today on YESTERDAY's sale, and a refund made tomorrow.
 *
 * NOT RUN by the authoring lane (no Postgres here): the DB lane runs it (`npm run local:test:db`, test tenants
 * only, collected only by jest.db.config.js).
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
import { CounterSaleTodayService } from "./counter-sale-today.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

/** The day under test: 2026-10-06 in New York (EDT, UTC-4) = 04:00:00.000Z to 2026-10-07 04:00:00.000Z. */
const DAY = "2026-10-06";
const NOW = new Date("2026-10-07T15:00:00.000Z"); // "today" is the 7th, so the 6th is a valid past day

type Pay = { method: string; amount: number; status?: string };
type Fixture = {
  key: string;
  at: string;
  tenant: "A" | "B";
  counterSale?: boolean;
  walkIn?: boolean;
  orderStatus?: string;
  invoiceStatus?: string;
  total: number;
  payments?: Pay[];
};

const FIXTURES: Fixture[] = [
  // in the day
  {
    key: "cash-walkin",
    at: "2026-10-06T18:00:00.000Z",
    tenant: "A",
    walkIn: true,
    total: 24.5,
    invoiceStatus: "PAID",
    payments: [
      { method: "CASH", amount: 24.5 },
      { method: "CASH", amount: 8, status: "DRAFT" },
    ],
  },
  {
    key: "card",
    at: "2026-10-06T17:00:00.000Z",
    tenant: "A",
    total: 9.99,
    invoiceStatus: "PAID",
    payments: [
      { method: "CREDIT_CARD", amount: 9.99 },
      { method: "CREDIT_CARD", amount: 5, status: "VOID" },
    ],
  },
  {
    key: "check",
    at: "2026-10-06T16:00:00.000Z",
    tenant: "A",
    total: 20,
    invoiceStatus: "PAID",
    payments: [
      { method: "CHECK", amount: 20 },
      { method: "CHECK", amount: 6, status: "PENDING" },
    ],
  },
  {
    key: "split-credit",
    at: "2026-10-06T15:00:00.000Z",
    tenant: "A",
    total: 10,
    invoiceStatus: "PAID",
    payments: [
      { method: "CREDIT_NOTE", amount: 4.5 },
      { method: "CASH", amount: 5.5 },
    ],
  },
  {
    key: "on-account",
    at: "2026-10-06T14:00:00.000Z",
    tenant: "A",
    total: 12.34,
    invoiceStatus: "SENT",
    payments: [],
  },
  {
    key: "cancelled",
    at: "2026-10-06T13:00:00.000Z",
    tenant: "A",
    total: 99,
    orderStatus: "CANCELLED",
    invoiceStatus: "VOID",
    payments: [{ method: "CASH", amount: 99 }],
  },
  {
    key: "edge-first-ms",
    at: "2026-10-06T04:00:00.000Z",
    tenant: "A",
    total: 1.1,
    invoiceStatus: "PAID",
    payments: [{ method: "CASH", amount: 1.1 }],
  },
  {
    key: "edge-last-ms",
    at: "2026-10-07T03:59:59.999Z",
    tenant: "A",
    total: 2.2,
    invoiceStatus: "PAID",
    payments: [{ method: "CASH", amount: 2.2 }],
  },
  // outside the day / not the tenant's counter sales
  {
    key: "just-before",
    at: "2026-10-06T03:59:59.999Z",
    tenant: "A",
    total: 50,
    invoiceStatus: "PAID",
    payments: [{ method: "CASH", amount: 50 }],
  },
  {
    key: "next-day-start",
    at: "2026-10-07T04:00:00.000Z",
    tenant: "A",
    total: 60,
    invoiceStatus: "PAID",
    payments: [{ method: "CASH", amount: 60 }],
  },
  {
    key: "not-counter",
    at: "2026-10-06T16:30:00.000Z",
    tenant: "A",
    counterSale: false,
    total: 33,
    invoiceStatus: "PAID",
    payments: [{ method: "CASH", amount: 33 }],
  },
  {
    key: "other-tenant",
    at: "2026-10-06T16:30:00.000Z",
    tenant: "B",
    total: 77,
    invoiceStatus: "PAID",
    payments: [{ method: "CASH", amount: 77 }],
  },
];

type ReturnFixture = {
  on: string; // fixture key of the order carrying the return
  status: string;
  refundMethod: "EXTERNAL_REFUND" | "CREDIT_NOTE";
  refundAmount?: number;
  credit?: [number, number, number];
  refundedAt?: string;
  createdAt?: string;
};
const RETURNS: ReturnFixture[] = [
  // a refund made IN the day on the day BEFORE's sale: counts
  {
    on: "just-before",
    status: "REFUNDED",
    refundMethod: "EXTERNAL_REFUND",
    refundAmount: 16,
    refundedAt: "2026-10-06T20:00:00.000Z",
  },
  // a refund made the NEXT day on this day's sale: does not count here
  {
    on: "cash-walkin",
    status: "REFUNDED",
    refundMethod: "EXTERNAL_REFUND",
    refundAmount: 5,
    refundedAt: "2026-10-07T10:00:00.000Z",
  },
  // a rejected refund inside the window: counts nowhere
  {
    on: "card",
    status: "REJECTED",
    refundMethod: "EXTERNAL_REFUND",
    refundAmount: 3,
    refundedAt: "2026-10-06T19:00:00.000Z",
  },
  // store credit captured in the day
  {
    on: "card",
    status: "PROCESSED",
    refundMethod: "CREDIT_NOTE",
    credit: [3, 0.3, 0],
    createdAt: "2026-10-06T19:30:00.000Z",
  },
];

const cents = (n: number) => Math.round(n * 100);

/** The reference answer, from the fixtures alone (integer cents, plain JS). */
function expected() {
  const start = Date.parse("2026-10-06T04:00:00.000Z");
  const end = Date.parse("2026-10-07T04:00:00.000Z");
  const inDay = (f: Fixture) =>
    f.tenant === "A" &&
    f.counterSale !== false &&
    Date.parse(f.at) >= start &&
    Date.parse(f.at) < end;
  const live = (f: Fixture) => f.orderStatus !== "CANCELLED" && f.invoiceStatus !== "VOID";
  const sold = FIXTURES.filter((f) => inDay(f) && live(f));
  const paid = sold.flatMap((f) => f.payments ?? []).filter((p) => (p.status ?? "PAID") === "PAID");
  const sum = (m: string[]) =>
    paid.filter((p) => m.includes(p.method)).reduce((s, p) => s + cents(p.amount), 0);
  const refunds = RETURNS.filter(
    (r) =>
      !["REJECTED", "CANCELLED"].includes(r.status) &&
      r.refundMethod === "EXTERNAL_REFUND" &&
      Date.parse(r.refundedAt as string) >= start &&
      Date.parse(r.refundedAt as string) < end,
  );
  const credits = RETURNS.filter(
    (r) =>
      !["REJECTED", "CANCELLED"].includes(r.status) &&
      r.refundMethod === "CREDIT_NOTE" &&
      Date.parse(r.createdAt as string) >= start &&
      Date.parse(r.createdAt as string) < end,
  );
  const cash = sum(["CASH"]);
  const card = sum(["CREDIT_CARD"]);
  const check = sum(["CHECK"]);
  const credit = sum(["CREDIT_NOTE", "ADVANCE"]);
  const salesTotal = sold.reduce((s, f) => s + cents(f.total), 0);
  const refundTotal = refunds.reduce((s, r) => s + cents(r.refundAmount as number), 0);
  return {
    rowKeys: FIXTURES.filter(inDay).map((f) => f.key),
    count: sold.length,
    salesTotal: salesTotal / 100,
    cash: cash / 100,
    card: card / 100,
    check: check / 100,
    moneyIn: (cash + card + check) / 100,
    credit: credit / 100,
    onAccount: Math.max(0, salesTotal - (cash + card + check) - credit) / 100,
    refundCount: refunds.length,
    refundTotal: refundTotal / 100,
    creditIssued:
      credits.reduce((s, r) => s + (r.credit as number[]).reduce((a, n) => a + cents(n), 0), 0) /
      100,
    net: (cash + card + check - refundTotal) / 100,
  };
}

describeDb("POS-7b-1 — GET /orders/counter-sale/today on real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: CounterSaleTodayService;
  const run = randomUUID().slice(0, 8);
  const slugA = assertTestTenant(`qa-cs-today-a-${run}`, "counter-sale-today.db.spec.ts");
  const slugB = assertTestTenant(`qa-cs-today-b-${run}`, "counter-sale-today.db.spec.ts");
  const tenants: Record<"A" | "B", string> = { A: "", B: "" };
  const userIds: string[] = [];
  const customers: Record<string, string> = {}; // `${tenant}-named` / `${tenant}-walkin`
  const orderIdByKey: Record<string, string> = {};
  const invoiceIdByKey: Record<string, string> = {};
  let n = 0;

  async function customer(tenant: "A" | "B", walkIn: boolean): Promise<string> {
    const k = `${tenant}-${walkIn ? "walkin" : "named"}`;
    if (customers[k]) return customers[k];
    const user = await raw.user.create({
      data: {
        email: `c-${k}-${run}@example.test`,
        username: `c-${k}-${run}`,
        role: "CUSTOMER",
        tenantId: tenants[tenant],
      },
    });
    userIds.push(user.id);
    const c = await raw.customer.create({
      data: {
        userId: user.id,
        businessName: walkIn ? "Walk-in" : `Acme Test ${tenant} ${run}`,
        contactName: "Tester",
        isWalkIn: walkIn,
        tenantId: tenants[tenant],
      },
    });
    customers[k] = c.id;
    return c.id;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    service = new CounterSaleTodayService(prisma);
    tenants.A = (await raw.tenant.create({ data: { slug: slugA, name: `Today A ${slugA}` } })).id;
    tenants.B = (await raw.tenant.create({ data: { slug: slugB, name: `Today B ${slugB}` } })).id;
    await raw.tenantConfig.create({
      data: { tenantId: tenants.A, timezone: "America/New_York" },
    });
    await raw.tenantConfig.create({
      data: { tenantId: tenants.B, timezone: "America/New_York" },
    });

    for (const f of FIXTURES) {
      const customerId = await customer(f.tenant, !!f.walkIn);
      n += 1;
      const order = await raw.order.create({
        data: {
          customerId,
          tenantId: tenants[f.tenant],
          counterSale: f.counterSale !== false,
          status: (f.orderStatus ?? "DELIVERED") as never,
          orderNumber: `T${run}-${n}`,
          total: f.total,
          createdAt: new Date(f.at),
        },
      });
      orderIdByKey[f.key] = order.id;
      const invoice = await raw.invoice.create({
        data: {
          invoiceNumber: `INV-${run}-${n}`,
          customerId,
          orderId: order.id,
          tenantId: tenants[f.tenant],
          status: (f.invoiceStatus ?? "SENT") as never,
          subtotal: f.total,
          total: f.total,
        },
      });
      invoiceIdByKey[f.key] = invoice.id;
      for (const p of f.payments ?? []) {
        await raw.invoicePayment.create({
          data: {
            invoiceId: invoice.id,
            tenantId: tenants[f.tenant],
            amount: p.amount,
            method: p.method as never,
            status: (p.status ?? "PAID") as never,
          },
        });
      }
    }
    let r = 0;
    for (const rf of RETURNS) {
      r += 1;
      await raw.return.create({
        data: {
          returnNumber: `R${run}-${r}`,
          orderId: orderIdByKey[rf.on],
          customerId: await customer("A", false),
          tenantId: tenants.A,
          reason: "DAMAGED",
          status: rf.status as never,
          refundMethod: rf.refundMethod,
          refundAmount: rf.refundAmount ?? null,
          refundedAt: rf.refundedAt ? new Date(rf.refundedAt) : null,
          createdAt: rf.createdAt ? new Date(rf.createdAt) : new Date("2026-10-05T12:00:00.000Z"),
          creditSubtotal: rf.credit?.[0] ?? null,
          creditTax: rf.credit?.[1] ?? null,
          creditCategoryTax: rf.credit?.[2] ?? null,
        },
      });
    }
  }, 120_000);

  afterAll(async () => {
    const orderIds = Object.values(orderIdByKey);
    await raw.return.deleteMany({ where: { orderId: { in: orderIds } } });
    await raw.invoicePayment.deleteMany({
      where: { invoiceId: { in: Object.values(invoiceIdByKey) } },
    });
    await raw.invoice.deleteMany({ where: { id: { in: Object.values(invoiceIdByKey) } } });
    await raw.order.deleteMany({ where: { id: { in: orderIds } } });
    await raw.customer.deleteMany({ where: { id: { in: Object.values(customers) } } });
    await raw.user.deleteMany({ where: { id: { in: userIds } } });
    await raw.tenantConfig.deleteMany({ where: { tenantId: { in: Object.values(tenants) } } });
    await raw.tenant.deleteMany({ where: { id: { in: Object.values(tenants) } } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  const read = (q: { page?: number; limit?: number; day?: string } = {}, as: "A" | "B" = "A") =>
    tenantCtx.run(tenants[as], () =>
      service.today({ day: DAY, page: 1, limit: 100, ...q } as never, NOW),
    );

  it("14. the three grouped queries equal the same figures folded in JS from the fixtures", async () => {
    const want = expected();
    const res = await read();
    const s = res.summary!;
    expect(s.sales).toEqual({ count: want.count, total: want.salesTotal });
    expect(s.moneyIn).toEqual({
      cash: want.cash,
      card: want.card,
      check: want.check,
      other: 0,
      total: want.moneyIn,
    });
    expect(s.storeCreditUsed).toBe(want.credit);
    expect(s.onAccount).toBe(want.onAccount);
    expect(s.refunds).toMatchObject({ count: want.refundCount, total: want.refundTotal });
    expect(s.storeCreditIssued).toEqual({ count: 1, amount: want.creditIssued });
    expect(s.netCollected).toBe(want.net);
    // the refund tender is not stored: cash expected is cash taken, not reduced
    expect(s.cashExpectedInDrawer).toBe(want.cash);
    expect(s.refunds.tenderKnown).toBe(false);
  });

  it("14. the day window to the millisecond: rows are exactly the in-window counter sales of this tenant", async () => {
    const want = expected();
    const res = await read();
    expect(res.meta).toMatchObject({
      total: want.rowKeys.length,
      day: DAY,
      timezone: "America/New_York",
      windowStart: "2026-10-06T04:00:00.000Z",
      windowEnd: "2026-10-07T04:00:00.000Z",
    });
    const ids = new Set(res.data.map((r) => r.orderId));
    for (const f of FIXTURES) {
      expect(ids.has(orderIdByKey[f.key])).toBe(want.rowKeys.includes(f.key));
    }
    // newest first
    const times = res.data.map((r) => Date.parse(r.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("7. another tenant's counter sales appear in no row, total or figure", async () => {
    const a = await read({}, "A");
    const b = await read({}, "B");
    expect(a.data.some((r) => r.orderId === orderIdByKey["other-tenant"])).toBe(false);
    expect(b.data.map((r) => r.orderId)).toEqual([orderIdByKey["other-tenant"]]);
    expect(b.summary).toMatchObject({
      sales: { count: 1, total: 77 },
      moneyIn: { cash: 77, total: 77 },
      refunds: { count: 0, total: 0 },
    });
    expect(a.summary!.moneyIn.cash).not.toBe(b.summary!.moneyIn.cash);
  });

  it("8. rows carry the stored methods, state, voided flag and returns", async () => {
    const res = await read();
    const row = (k: string) => res.data.find((r) => r.orderId === orderIdByKey[k])!;
    expect(row("cash-walkin")).toMatchObject({
      isWalkIn: true,
      paymentState: "PAID",
      methods: [{ method: "CASH", amount: 24.5 }],
      voided: false,
      // a refund made the NEXT day still reads on the sale's own row (the rows are the sale's history)
      returned: { state: "PARTLY", amount: 5 },
    });
    expect(row("card").methods).toEqual([{ method: "CARD", amount: 9.99 }]);
    expect(row("split-credit").methods).toEqual([
      { method: "CASH", amount: 5.5 },
      { method: "STORE_CREDIT", amount: 4.5 },
    ]);
    expect(row("on-account")).toMatchObject({ paymentState: "ON_ACCOUNT", balanceDue: 12.34 });
    expect(row("cancelled")).toMatchObject({ voided: true });
    // a stored STORE_CREDIT return of 3.30 on a 9.99 sale: partly returned; the rejected refund is ignored
    expect(row("card").returned).toMatchObject({ state: "PARTLY", amount: 3.3 });
    expect(row("card").returned.returns).toHaveLength(1);
  });

  it("4. pages: limit 3 walks the whole day with no repeat or gap; summary only on page 1", async () => {
    const want = expected();
    const pages = [];
    for (let page = 1; page <= Math.ceil(want.rowKeys.length / 3); page += 1) {
      pages.push(await read({ page, limit: 3 }));
    }
    const ids = pages.flatMap((p) => p.data.map((r) => r.orderId));
    expect(ids).toHaveLength(want.rowKeys.length);
    expect(new Set(ids).size).toBe(ids.length);
    expect(pages[0].summary).not.toBeNull();
    expect(pages.slice(1).every((p) => p.summary === null)).toBe(true);
  });

  it("5. a future day is refused; an empty past day answers an empty day", async () => {
    await expect(read({ day: "2026-10-08" })).rejects.toMatchObject({ status: 400 });
    const empty = await read({ day: "2026-09-01" });
    expect(empty.data).toEqual([]);
    expect(empty.summary?.sales).toEqual({ count: 0, total: 0 });
  });
});
