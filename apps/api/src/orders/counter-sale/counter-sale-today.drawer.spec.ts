import { CounterSaleTodayService } from "./counter-sale-today.service";
import type { CounterSaleTodayDto } from "./counter-sale-today.dto";
import { createMockPrisma } from "../../testing/prisma-mock";

/**
 * The end-of-day drawer over TWO days (MED-1) and the per-return amount rule (LOW-2), end to end through the
 * service: the Prisma stand-in below EVALUATES the `where` the service sends (equality, ranges, not / notIn,
 * OR, `some`, nested relations; any other shape throws), so these pins are about the real arguments.
 * Placeholders only (acme); no live-client data.
 */
const T = "test-tenant";
// New York, EDT (UTC-4). Day 1 = 2026-10-06, day 2 = 2026-10-07.
const NOW = new Date("2026-10-07T20:00:00.000Z");
const at = (s: string) => new Date(s);

type Payment = { method: string; amount: string; status: string; paidAt: Date };
type ReturnRow = {
  id: string;
  returnNumber: string;
  status: string;
  refundMethod: string | null;
  creditNoteId: string | null;
  refundAmount: string | null;
  creditSubtotal: string | null;
  creditTax: string | null;
  creditCategoryTax: string | null;
  refundedAt: Date | null;
  createdAt: Date;
};
type OrderRow = {
  id: string;
  tenantId: string;
  counterSale: boolean;
  status: string;
  orderNumber: string;
  total: string;
  createdAt: Date;
  customerId: string;
  customer: { businessName: string; isWalkIn: boolean };
  invoices: Array<{ id: string; invoiceNumber: string; status: string; payments: Payment[] }>;
  returns: ReturnRow[];
};

function order(over: Partial<OrderRow> & { id: string }): OrderRow {
  return {
    tenantId: T,
    counterSale: true,
    status: "DELIVERED",
    orderNumber: `N-${over.id}`,
    total: "10.00",
    createdAt: at("2026-10-06T16:00:00.000Z"),
    customerId: "c-1",
    customer: { businessName: "Acme Test Customer", isWalkIn: false },
    invoices: [],
    returns: [],
    ...over,
  };
}
const cash = (amount: string, paidAt: string): Payment => ({
  method: "CASH",
  amount,
  status: "PAID",
  paidAt: at(paidAt),
});
const creditReturn = (over: Partial<ReturnRow> & { id: string }): ReturnRow => ({
  returnNumber: `R-${over.id}`,
  status: "PROCESSED",
  refundMethod: "CREDIT_NOTE",
  creditNoteId: `cn-${over.id}`,
  refundAmount: null,
  creditSubtotal: null,
  creditTax: null,
  creditCategoryTax: null,
  refundedAt: null,
  createdAt: at("2026-10-06T18:00:00.000Z"),
  ...over,
});

/** Evaluate the subset of Prisma `where` the today's-sales queries use against a plain record. */
function m(rec: any, where: any): boolean {
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === "OR") return v.some((w: any) => m(rec, w));
    const val = rec?.[k];
    if (v !== null && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v)) {
      const ops = ["gte", "lt", "not", "notIn", "some", "in"];
      const keys = Object.keys(v);
      if (keys.every((x) => ops.includes(x))) {
        return (
          (v.gte === undefined || val >= v.gte) &&
          (v.lt === undefined || val < v.lt) &&
          (v.not === undefined || val !== v.not) &&
          (v.notIn === undefined || !v.notIn.includes(val)) &&
          (v.in === undefined || v.in.includes(val)) &&
          (v.some === undefined || (val as any[]).some((r) => m(r, v.some)))
        );
      }
      return m(val, v);
    }
    if (val === undefined) throw new Error(`the stand-in does not model the field ${k}`);
    return val === v;
  });
}

function setup(orders: OrderRow[]) {
  const prisma = createMockPrisma();
  prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: "America/New_York" });

  // the payments table and the returns table, derived from the orders
  const payments = orders.flatMap((o) =>
    o.invoices.flatMap((inv) =>
      inv.payments.map((p) => ({
        ...p,
        tenantId: o.tenantId,
        invoice: { tenantId: o.tenantId, status: inv.status, order: o },
      })),
    ),
  );
  const returns = orders.flatMap((o) =>
    o.returns.map((r) => ({
      ...r,
      tenantId: o.tenantId,
      order: { tenantId: o.tenantId, counterSale: o.counterSale },
    })),
  );

  prisma.order.findMany.mockImplementation(async (args: any) =>
    orders
      .filter((o) => m(o, args.where))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(args.skip, args.skip + args.take),
  );
  prisma.order.count.mockImplementation(
    async (args: any) => orders.filter((o) => m(o, args.where)).length,
  );
  prisma.order.aggregate.mockImplementation(async (args: any) => {
    const hit = orders.filter((o) => m(o, args.where));
    return {
      _count: { _all: hit.length },
      _sum: { total: hit.reduce((s, o) => s + Number(o.total), 0) },
    };
  });
  prisma.invoicePayment.groupBy.mockImplementation(async (args: any) => {
    const by = new Map<string, number>();
    for (const p of payments.filter((x) => m(x, args.where))) {
      by.set(p.method, (by.get(p.method) ?? 0) + Number(p.amount));
    }
    return [...by].map(([method, amount]) => ({ method, _sum: { amount } }));
  });
  prisma.invoicePayment.aggregate.mockImplementation(async (args: any) => ({
    _sum: {
      amount: payments.filter((x) => m(x, args.where)).reduce((s, p) => s + Number(p.amount), 0),
    },
  }));
  prisma.return.findMany.mockImplementation(async (args: any) =>
    returns.filter((r) => m(r, args.where)),
  );
  // a store-credit return's credit note is minted when the return is captured in these fixtures: it carries the return's createdAt
  const notes = returns
    .filter((r) => r.creditNoteId)
    .map((r) => ({
      id: r.creditNoteId as string,
      tenantId: r.tenantId,
      status: "ISSUED",
      createdAt: r.createdAt,
    }));
  prisma.creditNote.findMany.mockImplementation(async (args: any) =>
    notes.filter((n) => m(n, args.where)).map((n) => ({ id: n.id })),
  );

  const service = new CounterSaleTodayService(prisma as never);
  return (q: Partial<CounterSaleTodayDto>) =>
    service.today({ page: 1, limit: 50, ...q } as CounterSaleTodayDto, NOW);
}

describe("the drawer counts money on the day it came IN (MED-1)", () => {
  // A: rung on day 1, left on account, paid in cash on day 2. B: rung and paid in cash on day 1.
  const A = order({
    id: "a",
    total: "30.00",
    createdAt: at("2026-10-06T16:00:00.000Z"),
    invoices: [
      {
        id: "i-a",
        invoiceNumber: "INV-A",
        status: "PAID",
        payments: [cash("30.00", "2026-10-07T15:00:00.000Z")],
      },
    ],
  });
  const B = order({
    id: "b",
    total: "100.00",
    createdAt: at("2026-10-06T17:00:00.000Z"),
    invoices: [
      {
        id: "i-b",
        invoiceNumber: "INV-B",
        status: "PAID",
        payments: [cash("100.00", "2026-10-06T17:00:00.000Z")],
      },
    ],
  });
  const other = order({
    id: "x",
    tenantId: "t-globex",
    total: "77.00",
    invoices: [
      {
        id: "i-x",
        invoiceNumber: "INV-X",
        status: "PAID",
        payments: [cash("77.00", "2026-10-06T17:00:00.000Z")],
      },
    ],
  });

  it("day 1: sales are what was RUNG that day; cash in is only what was paid that day", async () => {
    const res = await setup([A, B, other])({ day: "2026-10-06" });
    expect(res.summary!.sales).toEqual({ count: 2, total: 130 });
    expect(res.summary!.moneyIn).toMatchObject({ cash: 100, total: 100 });
    expect(res.summary!.cashExpectedInDrawer).toBe(100);
    // A is paid by now (on day 2), so nothing of day 1's sales is still owed
    expect(res.summary!.onAccount).toBe(0);
  });

  it("day 2: no sales were rung, but the day-1 sale paid in cash today IS today's cash", async () => {
    const res = await setup([A, B, other])({ day: "2026-10-07" });
    expect(res.data).toEqual([]);
    expect(res.summary!.sales).toEqual({ count: 0, total: 0 });
    expect(res.summary!.moneyIn).toMatchObject({ cash: 30, total: 30 });
    expect(res.summary!.cashExpectedInDrawer).toBe(30);
    expect(res.summary!.netCollected).toBe(30);
  });

  it("a payment on a cancelled sale or a VOID invoice is never money in, on any day", async () => {
    const dead = order({
      id: "d",
      status: "CANCELLED",
      invoices: [
        {
          id: "i-d",
          invoiceNumber: "INV-D",
          status: "VOID",
          payments: [cash("50.00", "2026-10-07T15:00:00.000Z")],
        },
      ],
    });
    const res = await setup([dead])({ day: "2026-10-07" });
    expect(res.summary!.moneyIn.cash).toBe(0);
  });
});

describe("a return is worth the same in the rows and in the summary (LOW-2)", () => {
  it("a $20 priced + a $15 legacy return is $35 in storeCreditIssued AND in the sale's returned amount", async () => {
    const sale = order({
      id: "s",
      total: "100.00",
      invoices: [
        {
          id: "i-s",
          invoiceNumber: "INV-S",
          status: "PAID",
          payments: [cash("100.00", "2026-10-06T16:00:00.000Z")],
        },
      ],
      returns: [
        creditReturn({ id: "r1", creditSubtotal: "20.00", creditTax: "0", creditCategoryTax: "0" }),
        creditReturn({ id: "r2", refundAmount: "15.00" }), // legacy: no priced split
      ],
    });
    const res = await setup([sale])({ day: "2026-10-06" });
    expect(res.summary!.storeCreditIssued).toEqual({ count: 2, amount: 35 });
    const row = res.data[0];
    expect(row.returned.returns.map((r) => r.amount).sort()).toEqual([15, 20]);
    expect(row.returned.amount).toBe(35);
    expect(row.returned.amount).toBe(res.summary!.storeCreditIssued.amount);
  });
});
