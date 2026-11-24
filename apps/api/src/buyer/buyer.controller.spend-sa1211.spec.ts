/**
 * SA-1211 A1.3 (FIX-SPEND): the buyer portal's "Total spend" and monthly chart come from the buyer's
 * INVOICES (issued ones), less their posted credit notes, never from orders. Before the fix an
 * invoice-only buyer read $0.00 (`GET /buyer/analytics` summed `db.order`).
 *
 * The db here is an in-memory fake that APPLIES the `where` it is given (customer, status, date floor), so
 * a wrong filter shows up as a wrong number. It is reached ONLY through `forTenant()`: the bare prisma
 * object has no model, so an unscoped read throws.
 */
jest.mock("../invoices/invoice-pdf.service", () => ({ InvoicePdfService: jest.fn() }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { BuyerController } from "./buyer.controller";

type Row = Record<string, any>;
const NOW = new Date("2026-11-15T18:00:00.000Z");
// Oct 31 23:30 in Chicago (CDT, UTC-5) is Nov 1 04:30Z: the month-end case.
const OCT_31_2330_CHICAGO = new Date("2026-11-01T04:30:00.000Z");

const matches = (row: Row, where: Row): boolean =>
  Object.entries(where).every(([key, cond]) => {
    const v = row[key];
    if (cond === null || typeof cond !== "object" || cond instanceof Date) return v === cond;
    return Object.entries(cond as Row).every(([op, arg]) => {
      if (op === "in") return (arg as any[]).includes(v);
      if (op === "notIn") return !(arg as any[]).includes(v);
      if (op === "not") return v !== arg;
      if (op === "gte") return v >= arg;
      throw new Error(`fake db: unsupported filter ${key}.${op}`);
    });
  });

function fakeModel(rows: Row[], sumField: string) {
  const pick = (where: Row = {}) => rows.filter((r) => matches(r, where));
  return {
    findMany: jest.fn(async (args: Row = {}) => pick(args.where)),
    count: jest.fn(async (args: Row = {}) => pick(args.where).length),
    aggregate: jest.fn(async (args: Row = {}) => {
      const hit = pick(args.where);
      return {
        _sum: { [sumField]: hit.length ? hit.reduce((s, r) => s + Number(r[sumField]), 0) : null },
        _count: hit.length,
      };
    }),
  };
}

interface Data {
  invoices?: Row[];
  creditNotes?: Row[];
  orders?: Row[];
}
const inv = (o: Row) => ({
  customerId: "cust-1",
  status: "SENT",
  dueDate: new Date("2099-01-01T00:00:00.000Z"),
  issueDate: new Date("2026-10-10T00:00:00.000Z"),
  payments: [],
  ...o,
});
const note = (o: Row) => ({
  customerId: "cust-1",
  status: "ISSUED",
  createdAt: new Date("2026-10-12T15:00:00.000Z"),
  ...o,
});
const order = (o: Row) => ({
  customerId: "cust-1",
  status: "DELIVERED",
  createdAt: new Date("2026-10-09T15:00:00.000Z"),
  ...o,
});

function build(data: Data, zone = "America/Chicago") {
  const scoped = {
    invoice: fakeModel(data.invoices ?? [], "total"),
    creditNote: fakeModel(data.creditNotes ?? [], "amount"),
    order: fakeModel(data.orders ?? [], "total"),
    invoicePayment: { findMany: jest.fn(async () => []) },
  };
  // No model on the bare object: anything that skips forTenant() throws.
  const prisma = {
    forTenant: jest.fn(() => scoped),
    getTenantId: jest.fn(() => "tenant-1"),
    tenantConfig: { findUnique: jest.fn(async () => ({ timezone: zone })) },
  };
  const controller = Object.create(BuyerController.prototype) as BuyerController;
  (controller as any).prisma = prisma;
  return { controller, scoped, prisma };
}

const run = (data: Data, zone?: string, customerId = "cust-1") => {
  const { controller, ...rest } = build(data, zone);
  return controller.getAnalytics({ customerId }).then((res) => ({ res, ...rest }));
};

describe("BuyerController.getAnalytics: spend is invoices less credit notes (SA-1211 A1.3)", () => {
  beforeEach(() => {
    jest.useFakeTimers({
      now: NOW,
      doNotFake: ["nextTick", "setImmediate", "queueMicrotask"],
    });
  });
  afterEach(() => jest.useRealTimers());

  it("an invoice-only buyer shows the sum of the invoices, not $0", async () => {
    const { res } = await run({
      invoices: [inv({ total: 100 }), inv({ status: "PAID", total: 50 })],
    });
    expect(res.summary.totalSpend).toBe(150);
    expect(res.summary.totalOrders).toBe(0);
    expect(res.summary.avgOrderValue).toBe(0);
  });

  it("an order and the invoice made from it count once, at the invoice's total", async () => {
    const { res } = await run({
      orders: [order({ id: "o1", total: 100 })],
      invoices: [inv({ orderId: "o1", total: 120 })],
    });
    expect(res.summary.totalSpend).toBe(120); // not 100, and not 220
    expect(res.summary.totalOrders).toBe(1);
  });

  it("a counter sale (one invoice, no order) counts once, in one month", async () => {
    const { res } = await run({ invoices: [inv({ status: "PAID", total: 75 })] });
    expect(res.summary.totalSpend).toBe(75);
    expect(res.monthlySpend).toEqual([{ month: "2026-10", spend: 75, orderCount: 0 }]);
  });

  it("$100 with a $40 return is $60, and an applied credit note still comes off", async () => {
    const issued = await run({
      invoices: [inv({ status: "PAID", total: 100 })],
      creditNotes: [note({ amount: 40 })],
    });
    expect(issued.res.summary.totalSpend).toBe(60);
    expect(issued.res.monthlySpend).toEqual([{ month: "2026-10", spend: 60, orderCount: 0 }]);

    const applied = await run({
      invoices: [inv({ status: "PAID", total: 100 })],
      creditNotes: [note({ status: "APPLIED", amount: 40 })],
    });
    expect(applied.res.summary.totalSpend).toBe(60);
  });

  it("a VOID credit note does not come off", async () => {
    const { res } = await run({
      invoices: [inv({ total: 100 })],
      creditNotes: [note({ status: "VOID", amount: 40 })],
    });
    expect(res.summary.totalSpend).toBe(100);
  });

  it("VOID and DRAFT invoices are out; SENT, VIEWED, PARTIAL, PAID, OVERDUE and WRITTEN_OFF are in", async () => {
    const { res } = await run({
      invoices: [
        inv({ status: "SENT", total: 1 }),
        inv({ status: "VIEWED", total: 2 }),
        inv({ status: "PARTIAL", total: 4 }),
        inv({ status: "PAID", total: 8 }),
        inv({ status: "OVERDUE", total: 16 }),
        inv({ status: "WRITTEN_OFF", total: 32 }),
        inv({ status: "VOID", total: 1000 }),
        inv({ status: "DRAFT", total: 500 }),
      ],
    });
    expect(res.summary.totalSpend).toBe(63);
  });

  it("a sale at 23:30 tenant time on the last day of the month stays in that month", async () => {
    const { res } = await run({
      // Issued Oct 31 23:30 Chicago: the stored issue day is Oct 31, the instant is already Nov 1 in UTC.
      invoices: [
        inv({
          total: 100,
          issueDate: new Date("2026-10-31T00:00:00.000Z"),
          createdAt: OCT_31_2330_CHICAGO,
        }),
      ],
      creditNotes: [note({ amount: 10, createdAt: OCT_31_2330_CHICAGO })],
    });
    expect(res.monthlySpend).toEqual([{ month: "2026-10", spend: 90, orderCount: 0 }]);
  });

  it("the same instants fall in November for a tenant east of Chicago", async () => {
    const { res } = await run(
      { creditNotes: [note({ amount: 10, createdAt: OCT_31_2330_CHICAGO })] },
      "UTC",
    );
    expect(res.monthlySpend).toEqual([{ month: "2026-11", spend: -10, orderCount: 0 }]);
  });

  it("another customer's invoices, credit notes and orders are never counted", async () => {
    const other = { customerId: "cust-2" };
    const { res } = await run({
      invoices: [inv({ total: 100 }), inv({ ...other, total: 9000 })],
      creditNotes: [note({ amount: 5 }), note({ ...other, amount: 700 })],
      orders: [order({ total: 30 }), order({ ...other, total: 800 })],
    });
    expect(res.summary.totalSpend).toBe(95);
    expect(res.summary.totalOrders).toBe(1);
    expect(res.monthlySpend).toEqual([{ month: "2026-10", spend: 95, orderCount: 1 }]);
  });

  it("reads only through the tenant-scoped client, and every read is for the signed-in customer", async () => {
    const { scoped, prisma } = await run({ invoices: [inv({ total: 100 })] });
    expect(prisma.forTenant).toHaveBeenCalled();
    for (const model of [scoped.invoice, scoped.creditNote, scoped.order]) {
      for (const fn of [model.findMany, model.aggregate]) {
        for (const [args] of fn.mock.calls as any[]) {
          expect(args.where.customerId).toBe("cust-1");
        }
      }
    }
  });

  it("Avg order value stays order-based: it is never spend divided by anything", async () => {
    const { res } = await run({
      orders: [order({ total: 100 }), order({ total: 50 })],
      invoices: [inv({ total: 400 })],
    });
    expect(res.summary.totalSpend).toBe(400);
    expect(res.summary.totalOrders).toBe(2);
    expect(res.summary.avgOrderValue).toBe(75);
  });

  it("cancelled and draft orders are not counted as orders", async () => {
    const { res } = await run({
      orders: [
        order({ total: 100 }),
        order({ status: "CANCELLED", total: 900 }),
        order({ status: "DRAFT", total: 900 }),
      ],
    });
    expect(res.summary.totalOrders).toBe(1);
    expect(res.summary.avgOrderValue).toBe(100);
  });

  it("every money sum goes through roundMoney (0.1 + 0.2 is 0.3)", async () => {
    const { res } = await run({
      invoices: [inv({ total: 0.1 }), inv({ total: 0.2 })],
    });
    expect(res.summary.totalSpend).toBe(0.3);
  });

  it("the chart covers the last 12 months in the tenant's zone, oldest first", async () => {
    const { res } = await run({
      invoices: [
        inv({ total: 1, issueDate: new Date("2025-12-01T00:00:00.000Z") }), // this month and the 11 before: in
        inv({ total: 10, issueDate: new Date("2025-11-30T00:00:00.000Z") }), // the 13th month: out of the chart
        inv({ total: 100, issueDate: new Date("2026-11-03T00:00:00.000Z") }),
      ],
    });
    expect(res.monthlySpend).toEqual([
      { month: "2025-12", spend: 1, orderCount: 0 },
      { month: "2026-11", spend: 100, orderCount: 0 },
    ]);
    expect(res.summary.totalSpend).toBe(111); // the headline is all time
  });
});
