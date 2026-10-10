import { ForbiddenException } from "@nestjs/common";
import { CounterSaleTodayService } from "./counter-sale-today.service";
import type { CounterSaleTodayDto } from "./counter-sale-today.dto";
import { createMockPrisma, type MockPrisma } from "../../testing/prisma-mock";

/**
 * GET /orders/counter-sale/today, the service: the tenant-zone day window, pagination, the query budget and
 * tenant scoping. The page query runs against a small in-memory stand-in that applies the `where` /
 * `orderBy` / `skip` / `take` the service SENDS (and throws on a shape it does not model), so the window
 * assertions are about the real arguments, not about a mock's canned answer. Placeholders only (acme).
 */
type Row = {
  id: string;
  tenantId: string;
  counterSale: boolean;
  createdAt: Date;
  orderNumber: string;
};

const T = "test-tenant";
const iso = (s: string) => new Date(s);
let seq = 0;
const row = (createdAt: string, over: Partial<Row> = {}): Row => ({
  id: `o-${String(++seq).padStart(3, "0")}`,
  tenantId: T,
  counterSale: true,
  createdAt: iso(createdAt),
  orderNumber: `N${seq}`,
  ...over,
});

function pageRecord(r: Row) {
  return {
    id: r.id,
    orderNumber: r.orderNumber,
    status: "DELIVERED",
    total: "10.00",
    createdAt: r.createdAt,
    customerId: "c-1",
    customer: { businessName: "Acme Test Customer", isWalkIn: false },
    invoices: [],
    returns: [],
  };
}

function setup(rows: Row[], timezone: string | null = "America/New_York") {
  const prisma: MockPrisma = createMockPrisma();
  prisma.tenantConfig.findUnique.mockResolvedValue(timezone === undefined ? null : { timezone });
  const matches = (where: any) =>
    rows.filter(
      (r) =>
        r.tenantId === where.tenantId &&
        r.counterSale === where.counterSale &&
        r.createdAt >= where.createdAt.gte &&
        r.createdAt < where.createdAt.lt,
    );
  prisma.order.findMany.mockImplementation(async (args: any) => {
    expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    const sorted = [...matches(args.where)].sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
    return sorted.slice(args.skip, args.skip + args.take).map(pageRecord);
  });
  prisma.order.count.mockImplementation(async (args: any) => matches(args.where).length);
  const service = new CounterSaleTodayService(prisma as never);
  const call = (q: Partial<CounterSaleTodayDto> = {}, now?: Date) =>
    service.today({ page: 1, limit: 50, ...q } as CounterSaleTodayDto, now);
  return { prisma, service, call };
}

// 2026-10-07 is an ordinary EDT day in New York (UTC-4): its window is 04:00Z to 04:00Z.
const NOW = iso("2026-10-07T15:00:00.000Z");

describe("CounterSaleTodayService: the day window (tests 1-3)", () => {
  it("1. the tenant's day [00:00:00, next 00:00:00): the edges and a non-counter / other-tenant row", async () => {
    const inFirst = row("2026-10-07T04:00:01.000Z"); // 00:00:01 local
    const inLast = row("2026-10-08T03:59:59.000Z"); // 23:59:59 local
    const dayBefore = row("2026-10-07T03:59:59.000Z"); // 23:59:59 the day before
    const nextDay = row("2026-10-08T04:00:00.000Z"); // 00:00:00 the next day
    const notCounter = row("2026-10-07T16:00:00.000Z", { counterSale: false });
    const otherTenant = row("2026-10-07T16:00:00.000Z", { tenantId: "t-globex" });
    const { call } = setup([inFirst, inLast, dayBefore, nextDay, notCounter, otherTenant]);
    const res = await call({}, NOW);
    expect(res.data.map((r) => r.orderId)).toEqual([inLast.id, inFirst.id]);
    expect(res.meta).toMatchObject({
      total: 2,
      day: "2026-10-07",
      timezone: "America/New_York",
      windowStart: "2026-10-07T04:00:00.000Z",
      windowEnd: "2026-10-08T04:00:00.000Z",
    });
  });

  it("2. the same instants land on different days in another zone; the zone is echoed", async () => {
    const instant = "2026-10-07T05:00:00.000Z"; // 01:00 on the 7th in New York, 22:00 on the 6th in Los Angeles
    const rows = [row(instant)];
    const ny = await setup(rows, "America/New_York").call({ day: "2026-10-07" }, NOW);
    const la7 = await setup(rows, "America/Los_Angeles").call({ day: "2026-10-07" }, NOW);
    const la6 = await setup(rows, "America/Los_Angeles").call({ day: "2026-10-06" }, NOW);
    expect(ny.data).toHaveLength(1);
    expect(la7.data).toHaveLength(0);
    expect(la6.data).toHaveLength(1);
    expect(la7.meta.timezone).toBe("America/Los_Angeles");
    expect(la7.meta.windowStart).toBe("2026-10-07T07:00:00.000Z");
  });

  it("2. a null or unknown zone cuts a UTC window and echoes UTC", async () => {
    const rows = [row("2026-10-07T00:00:01.000Z"), row("2026-10-06T23:59:59.000Z")];
    for (const tz of [null, "Mars/Phobos"]) {
      const res = await setup(rows, tz).call({ day: "2026-10-07" }, NOW);
      expect(res.meta).toMatchObject({
        timezone: "UTC",
        windowStart: "2026-10-07T00:00:00.000Z",
        windowEnd: "2026-10-08T00:00:00.000Z",
      });
      expect(res.data).toHaveLength(1);
    }
  });

  it("3. DST spring forward, 2026-03-08 in New York: a 23-hour day, 01:30 is in, the next day starts at the right instant", async () => {
    const lateNight = row("2026-03-08T06:30:00.000Z"); // 01:30 EST, before the 02:00 jump
    const nextDayStart = row("2026-03-09T04:00:00.000Z"); // 00:00 EDT on the 9th
    const beforeStart = row("2026-03-08T04:59:59.000Z"); // 23:59:59 EST on the 7th
    const { call } = setup([lateNight, nextDayStart, beforeStart]);
    const res = await call({ day: "2026-03-08" }, NOW);
    expect(res.meta.windowStart).toBe("2026-03-08T05:00:00.000Z");
    expect(res.meta.windowEnd).toBe("2026-03-09T04:00:00.000Z");
    const hours = (Date.parse(res.meta.windowEnd) - Date.parse(res.meta.windowStart)) / 3_600_000;
    expect(hours).toBe(23);
    expect(res.data.map((r) => r.orderId)).toEqual([lateNight.id]);
  });

  it("3. DST fall back, 2026-11-01 in New York: a 25-hour day, both 01:30s are in, the next day starts at the right instant", async () => {
    const firstOneThirty = row("2026-11-01T05:30:00.000Z"); // 01:30 EDT
    const secondOneThirty = row("2026-11-01T06:30:00.000Z"); // 01:30 EST, an hour later
    const nextDayStart = row("2026-11-02T05:00:00.000Z"); // 00:00 EST on the 2nd
    const beforeStart = row("2026-11-01T03:59:59.000Z"); // 23:59:59 EDT on the 31st
    const { call } = setup([firstOneThirty, secondOneThirty, nextDayStart, beforeStart]);
    // "now" is the day AFTER the fall-back day: a day later than the tenant's today is refused.
    const res = await call({ day: "2026-11-01" }, iso("2026-11-02T15:00:00.000Z"));
    expect(res.meta.windowStart).toBe("2026-11-01T04:00:00.000Z");
    expect(res.meta.windowEnd).toBe("2026-11-02T05:00:00.000Z");
    const hours = (Date.parse(res.meta.windowEnd) - Date.parse(res.meta.windowStart)) / 3_600_000;
    expect(hours).toBe(25);
    expect(res.data.map((r) => r.orderId).sort()).toEqual(
      [firstOneThirty.id, secondOneThirty.id].sort(),
    );
  });

  it("the default day is the tenant's today, not UTC's (late evening New York is already tomorrow in UTC)", async () => {
    const { call } = setup([]);
    const res = await call({}, iso("2026-10-08T02:30:00.000Z")); // 22:30 on the 7th in New York
    expect(res.meta.day).toBe("2026-10-07");
  });
});

describe("CounterSaleTodayService: pagination (test 4)", () => {
  const sameInstant = "2026-10-07T16:00:00.000Z";
  const rows = [
    row("2026-10-07T17:00:00.000Z", { id: "o-a" }),
    row(sameInstant, { id: "o-b" }),
    row(sameInstant, { id: "o-c" }),
    row(sameInstant, { id: "o-d" }),
    row("2026-10-07T12:00:00.000Z", { id: "o-e" }),
  ];

  it("5 rows at limit 2: pages of 2 / 2 / 1, totalPages 3, ties by id desc, no row repeated or skipped", async () => {
    const { call, prisma } = setup(rows);
    const pages = [1, 2, 3].map((page) => call({ page, limit: 2 }, NOW));
    const [p1, p2, p3] = await Promise.all(pages);
    expect([p1, p2, p3].map((p) => p.data.length)).toEqual([2, 2, 1]);
    expect(p1.meta).toMatchObject({ total: 5, page: 1, limit: 2, totalPages: 3 });
    const ids = [...p1.data, ...p2.data, ...p3.data].map((r) => r.orderId);
    expect(ids).toEqual(["o-a", "o-d", "o-c", "o-b", "o-e"]);
    expect(new Set(ids).size).toBe(5);
    // skip / take are what the service sent for page 2
    expect(prisma.order.findMany.mock.calls.some(([a]) => a.skip === 2 && a.take === 2)).toBe(true);
  });

  it("summary is null on page 2+ and identical on page 1 for any limit", async () => {
    const { prisma, call } = setup(rows);
    prisma.order.aggregate.mockResolvedValue({ _count: { _all: 5 }, _sum: { total: "50.00" } });
    const a = await call({ page: 1, limit: 2 }, NOW);
    const b = await call({ page: 1, limit: 100 }, NOW);
    const p2 = await call({ page: 2, limit: 2 }, NOW);
    expect(a.summary).not.toBeNull();
    expect(a.summary).toEqual(b.summary);
    expect(p2.summary).toBeNull();
  });
});

describe("CounterSaleTodayService: day validation (test 5)", () => {
  it.each(["2026-02-30", "2026-13-01", "abc", "", "2026-1-5"])("%p is a coded 400", async (day) => {
    const { call } = setup([]);
    await expect(call({ day }, NOW)).rejects.toMatchObject({
      status: 400,
      response: { code: "COUNTER_SALES_DAY_INVALID" },
    });
  });

  it("a day after the tenant's today is a coded 400; today and a past day work", async () => {
    const { call } = setup([]);
    await expect(call({ day: "2026-10-08" }, NOW)).rejects.toMatchObject({
      status: 400,
      response: { code: "COUNTER_SALES_DAY_INVALID" },
    });
    await expect(call({ day: "2026-10-07" }, NOW)).resolves.toBeDefined();
    await expect(call({ day: "2026-10-06" }, NOW)).resolves.toBeDefined();
  });

  it("the future check is the TENANT's today: 22:30 on the 7th in New York (already the 8th in UTC) still accepts the 7th, refuses the 8th", async () => {
    const { call } = setup([]);
    const late = iso("2026-10-08T02:30:00.000Z");
    await expect(call({ day: "2026-10-07" }, late)).resolves.toBeDefined();
    await expect(call({ day: "2026-10-08" }, late)).rejects.toMatchObject({ status: 400 });
  });
});

describe("CounterSaleTodayService: no capability gate (test 6, service half)", () => {
  it("is built from Prisma alone (no capability reader): a tenant with counter sales off gets an empty day", async () => {
    const { call } = setup([]);
    const res = await call({}, NOW);
    expect(res.data).toEqual([]);
    expect(res.meta.total).toBe(0);
    expect(res.summary?.sales).toEqual({ count: 0, total: 0 });
  });

  it("refuses an unscoped session (forTenant() is unscoped without a tenant)", async () => {
    const { prisma, call } = setup([]);
    prisma.getTenantId.mockReturnValue(null);
    await expect(call({}, NOW)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.order.findMany).not.toHaveBeenCalled();
  });
});

describe("CounterSaleTodayService: tenant scoping (test 7, unit half)", () => {
  it("every read carries the session's tenantId (the DB lane proves it against two real tenants)", async () => {
    const { prisma, call } = setup([]);
    await call({}, NOW);
    const wheres = [
      prisma.order.findMany.mock.calls[0][0].where,
      prisma.order.count.mock.calls[0][0].where,
      prisma.order.aggregate.mock.calls[0][0].where,
      prisma.invoicePayment.groupBy.mock.calls[0][0].where,
      prisma.invoicePayment.groupBy.mock.calls[0][0].where.invoice,
      prisma.invoicePayment.groupBy.mock.calls[0][0].where.invoice.order,
      prisma.invoicePayment.aggregate.mock.calls[0][0].where,
      prisma.invoicePayment.aggregate.mock.calls[0][0].where.invoice,
      prisma.invoicePayment.aggregate.mock.calls[0][0].where.invoice.order,
      prisma.return.findMany.mock.calls[0][0].where,
      prisma.return.findMany.mock.calls[0][0].where.order,
    ];
    for (const w of wheres) expect(w.tenantId).toBe(T);
  });

  it("the page and the count share ONE where; the summary counts only live sales", async () => {
    const { prisma, call } = setup([]);
    await call({}, NOW);
    expect(prisma.order.count.mock.calls[0][0].where).toEqual(
      prisma.order.findMany.mock.calls[0][0].where,
    );
    const live = prisma.order.aggregate.mock.calls[0][0].where;
    expect(live.status).toEqual({ not: "CANCELLED" });
    expect(live.invoices).toEqual({ some: { status: { notIn: ["VOID", "WRITTEN_OFF"] } } });
    expect(prisma.invoicePayment.groupBy.mock.calls[0][0].where.status).toBe("PAID");
  });

  it("MED-1: money in is keyed to the PAID date on counter sales of ANY day; on-account is measured on the day's own sales", async () => {
    const { prisma, call } = setup([]);
    await call({}, NOW);
    const start = iso("2026-10-07T04:00:00.000Z");
    const end = iso("2026-10-08T04:00:00.000Z");
    const money = prisma.invoicePayment.groupBy.mock.calls[0][0].where;
    expect(money.paidAt).toEqual({ gte: start, lt: end });
    expect(money.status).toBe("PAID");
    expect(money.invoice.status).toEqual({ notIn: ["VOID", "WRITTEN_OFF"] });
    // the SALE's own day is not a filter: a day-1 sale paid today counts today
    expect(money.invoice.order).toEqual({
      tenantId: T,
      counterSale: true,
      status: { not: "CANCELLED" },
    });
    const owed = prisma.invoicePayment.aggregate.mock.calls[0][0].where;
    expect(owed.paidAt).toBeUndefined(); // any payment date
    expect(owed.invoice.order.createdAt).toEqual({ gte: start, lt: end }); // the day's own sales
  });

  it("NIT: a sale with NO invoice is listed on the page but not counted: the summary's sale filter needs a live invoice", async () => {
    const { prisma, call } = setup([row("2026-10-07T16:00:00.000Z")]);
    const res = await call({}, NOW);
    expect(res.data).toHaveLength(1); // the page's where has no invoice condition
    expect(prisma.order.findMany.mock.calls[0][0].where.invoices).toBeUndefined();
    expect(prisma.order.aggregate.mock.calls[0][0].where.invoices).toEqual({
      some: { status: { notIn: ["VOID", "WRITTEN_OFF"] } },
    });
  });

  it("refunds are keyed to the refund date, on counter sales of ANY day (no sale-day filter on the order)", async () => {
    const { prisma, call } = setup([]);
    await call({}, NOW);
    const where = prisma.return.findMany.mock.calls[0][0].where;
    expect(where.order).toEqual({ tenantId: T, counterSale: true });
    expect(where.order.createdAt).toBeUndefined();
    const start = iso("2026-10-07T04:00:00.000Z");
    const end = iso("2026-10-08T04:00:00.000Z");
    expect(where.OR).toContainEqual({
      refundMethod: "EXTERNAL_REFUND",
      refundedAt: { gte: start, lt: end },
    });
  });
});

describe("CounterSaleTodayService: query budget (test 12)", () => {
  it("a 50-row page 1 is a fixed number of calls: zone 1, page 1, count 1, then exactly five summary queries", async () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      row(
        `2026-10-07T${String(10 + Math.floor(i / 6)).padStart(2, "0")}:${String((i % 6) * 10).padStart(2, "0")}:00.000Z`,
      ),
    );
    const { prisma, call } = setup(rows);
    const res = await call({ page: 1, limit: 50 }, NOW);
    expect(res.data).toHaveLength(50);
    expect(prisma.tenantConfig.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.order.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.order.count).toHaveBeenCalledTimes(1);
    expect(prisma.order.aggregate).toHaveBeenCalledTimes(1);
    expect(prisma.invoicePayment.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.invoicePayment.aggregate).toHaveBeenCalledTimes(1);
    expect(prisma.return.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.creditNote.findMany).toHaveBeenCalledTimes(1);
    // nothing else is read: no per-row call on any other model
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
    expect(prisma.return.groupBy).not.toHaveBeenCalled();
    expect(prisma.invoicePayment.findMany).not.toHaveBeenCalled();
    expect(prisma.customer.findMany).not.toHaveBeenCalled();
  });

  it("page 2 runs NO summary query", async () => {
    const { prisma, call } = setup([row("2026-10-07T16:00:00.000Z")]);
    await call({ page: 2, limit: 1 }, NOW);
    expect(prisma.order.aggregate).not.toHaveBeenCalled();
    expect(prisma.invoicePayment.groupBy).not.toHaveBeenCalled();
    expect(prisma.invoicePayment.aggregate).not.toHaveBeenCalled();
    expect(prisma.return.findMany).not.toHaveBeenCalled();
    expect(prisma.creditNote.findMany).not.toHaveBeenCalled();
    expect(prisma.order.findMany).toHaveBeenCalledTimes(1);
  });

  it("the page query selects (never includes) and carries no line items or cost fields", async () => {
    const { prisma, call } = setup([]);
    await call({}, NOW);
    const args = prisma.order.findMany.mock.calls[0][0];
    expect(args.include).toBeUndefined();
    expect(Object.keys(args.select).sort()).toEqual(
      [
        "createdAt",
        "customer",
        "customerId",
        "id",
        "invoices",
        "orderNumber",
        "returns",
        "status",
        "total",
      ].sort(),
    );
  });
});
