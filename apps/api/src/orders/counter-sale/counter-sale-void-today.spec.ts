import { CounterSaleTodayService } from "./counter-sale-today.service";
import type { CounterSaleTodayDto } from "./counter-sale-today.dto";
import { createMockPrisma } from "../../testing/prisma-mock";

/**
 * SA-762r test 7 (guard): Today's sales after a counter-sale void. The void leaves exactly this storage: the order
 * CANCELLED, every invoice VOID and the tender payments VOID. The row must then read Voided, and the drawer
 * (`moneyIn.cash`, `cashExpectedInDrawer`) must drop by the voided cash, through the REAL service. The Prisma
 * stand-in (copied from counter-sale-today.drawer.spec.ts) EVALUATES the `where` the service sends. Placeholders only.
 */
const T = "test-tenant";
// New York, EDT (UTC-4): "today" is 2026-10-07.
const NOW = new Date("2026-10-07T20:00:00.000Z");
const at = (s: string) => new Date(s);

type Payment = { method: string; amount: string; status: string; paidAt: Date };
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
  returns: Array<{ creditNoteId?: string | null; createdAt?: Date } & Record<string, unknown>>;
};

function order(over: Partial<OrderRow> & { id: string }): OrderRow {
  return {
    tenantId: T,
    counterSale: true,
    status: "DELIVERED",
    orderNumber: `N-${over.id}`,
    total: "10.00",
    createdAt: at("2026-10-07T16:00:00.000Z"),
    customerId: "c-1",
    customer: { businessName: "Acme Test Customer", isWalkIn: false },
    invoices: [],
    returns: [],
    ...over,
  };
}
const pay = (method: string, amount: string, status = "PAID"): Payment => ({
  method,
  amount,
  status,
  paidAt: at("2026-10-07T16:00:00.000Z"),
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
  // the counter payments are read as rows (row 374 a); the hand-over candidate read finds none in these fixtures
  prisma.invoicePayment.findMany.mockImplementation(async (args: any) =>
    args.where?.invoice?.order?.counterSale === false
      ? []
      : payments
          .filter((x) => m(x, args.where))
          .map((p, i) => ({
            amount: p.amount,
            method: p.method,
            status: "PAID",
            paymentGroupId: null,
            checkStatus: null,
            invoice: { orderId: `void-today-order-${i}` },
          })),
  );
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

/** A cash $30 + card $20 sale on two sibling invoices: live, then as the void leaves it. */
const sale = (voided: boolean) =>
  order({
    id: "s1",
    total: "50.00",
    status: voided ? "CANCELLED" : "DELIVERED",
    invoices: [
      {
        id: "i1",
        invoiceNumber: "INV-1",
        status: voided ? "VOID" : "PAID",
        payments: [pay("CASH", "30.00", voided ? "VOID" : "PAID")],
      },
      {
        id: "i2",
        invoiceNumber: "INV-2",
        status: voided ? "VOID" : "PAID",
        payments: [pay("CREDIT_CARD", "20.00", voided ? "VOID" : "PAID")],
      },
    ],
  });
const keeper = order({
  id: "s2",
  total: "40.00",
  invoices: [
    { id: "i3", invoiceNumber: "INV-3", status: "PAID", payments: [pay("CASH", "40.00")] },
  ],
});

describe("Today's sales after a counter-sale void (SA-762r test 7)", () => {
  it("before the void the drawer holds the sale's cash; after it the row reads Voided and the drawer drops by exactly that cash", async () => {
    const before = await setup([sale(false), keeper])({ day: "2026-10-07" });
    expect(before.summary!.moneyIn.cash).toBe(70);
    expect(before.summary!.cashExpectedInDrawer).toBe(70);
    expect(before.summary!.sales).toEqual({ count: 2, total: 90 });
    expect(before.data.find((r) => r.orderNumber === "N-s1")!.voided).toBe(false);

    const after = await setup([sale(true), keeper])({ day: "2026-10-07" });
    const row = after.data.find((r) => r.orderNumber === "N-s1")!;
    expect(row.voided).toBe(true);
    expect(after.summary!.moneyIn.cash).toBe(before.summary!.moneyIn.cash - 30);
    expect(after.summary!.cashExpectedInDrawer).toBe(before.summary!.cashExpectedInDrawer - 30);
    expect(after.summary!.cashExpectedInDrawer).toBe(40);
    // the voided sale leaves the day's sales count and total; the other sale is untouched
    expect(after.summary!.sales).toEqual({ count: 1, total: 40 });
  });
});
