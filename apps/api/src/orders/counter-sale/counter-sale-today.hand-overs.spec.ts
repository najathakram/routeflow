import { FulfillPath } from "@prisma/client";
import { createMockPrisma, type MockPrisma } from "../../testing/prisma-mock";
import {
  foldSummary,
  handOverCandidatesWhere,
  handOverPayments,
  salePaymentsWhere,
} from "./counter-sale-today";
import { CounterSaleTodayService } from "./counter-sale-today.service";
import { pickupTenderGroupId } from "./pickup-tender-group";

/**
 * SA-763r R7 / red row 11: Today's sales sees a POS-mode hand-over's cash. A named customer's PICKUP order
 * handed over at the till takes its tender on an invoice of a NON-counter order, which the till's money in
 * never read. The "Hand-overs" line counts a PAID payment in the window whose invoice's order is
 * { PICKUP, counterSale: false } AND whose paymentGroupId is the app-side v5 of that order's hand-over; a
 * counter sale of the same day is counted once, by its own query. Placeholders only (acme).
 */
const T = "test-tenant";
const NOW = new Date("2026-10-07T15:00:00.000Z");
const none = { _sum: { amount: null } };
const pay = (orderId: string, method: string, amount: string, group?: string | null) => ({
  method,
  amount,
  paymentGroupId: group === undefined ? pickupTenderGroupId(orderId) : group,
  invoice: { orderId },
});

describe("handOverPayments — the code half of the predicate", () => {
  it("keeps only the payment whose group id is the v5 of ITS order", () => {
    const rows = [
      pay("o-1", "CASH", "50.00"), // the hand-over's tender
      pay("o-1", "CASH", "20.00", "11111111-2222-5333-8444-555555555555"), // a deposit / later payment
      pay("o-2", "CARD", "9.00", pickupTenderGroupId("o-1")), // another order's group id
      pay("o-3", "CASH", "7.00", null),
    ];
    expect(handOverPayments(rows)).toEqual([{ method: "CASH", amount: "50.00", orderId: "o-1" }]);
  });
});

describe("handOverCandidatesWhere — the SQL half", () => {
  const w = { start: new Date("2026-10-07T04:00:00Z"), end: new Date("2026-10-08T04:00:00Z") };

  it("is PAID in the window on a live invoice of a PICKUP, non-counter order", () => {
    expect(handOverCandidatesWhere(T, w)).toMatchObject({
      tenantId: T,
      status: "PAID",
      paidAt: { gte: w.start, lt: w.end },
      invoice: { order: { tenantId: T, fulfillPath: FulfillPath.PICKUP, counterSale: false } },
    });
  });

  it("is disjoint from the counter sale's money in (counterSale true vs false)", () => {
    expect(salePaymentsWhere(T, w).invoice.order.counterSale).toBe(true);
    expect(handOverCandidatesWhere(T, w).invoice.order.counterSale).toBe(false);
  });
});

describe("foldSummary — hand-overs are money in and cash expected", () => {
  it("adds the hand-over cash to moneyIn, cashExpectedInDrawer and netCollected, and reports the line", () => {
    const s = foldSummary({
      sales: { _count: { _all: 1 }, _sum: { total: "30.00" } },
      payments: [{ method: "CASH", _sum: { amount: "30.00" } }], // the counter sale's own cash
      paidOnSales: { _sum: { amount: "30.00" } },
      returns: [],
      handOvers: [
        { method: "CASH", amount: "50.00", orderId: "o-1" },
        { method: "CREDIT_CARD", amount: "12.50", orderId: "o-2" },
      ],
    });
    expect(s.handOvers).toEqual({ count: 2, total: 62.5 });
    expect(s.moneyIn).toEqual({ cash: 80, card: 12.5, check: 0, other: 0, total: 92.5 });
    expect(s.cashExpectedInDrawer).toBe(80);
    expect(s.netCollected).toBe(92.5);
    expect(s.sales).toEqual({ count: 1, total: 30 }); // the counter sale is not double counted
  });

  it("one hand-over tendered over two invoices is one hand-over", () => {
    const s = foldSummary({
      sales: { _count: { _all: 0 }, _sum: { total: null } },
      payments: [],
      paidOnSales: none,
      returns: [],
      handOvers: [
        { method: "CASH", amount: "30.00", orderId: "o-1" },
        { method: "CASH", amount: "10.00", orderId: "o-1" },
      ],
    });
    expect(s.handOvers).toEqual({ count: 1, total: 40 });
  });
});

describe("CounterSaleTodayService — a hand-over and a counter sale on the same day (row 11)", () => {
  function setup(candidates: unknown[]) {
    const prisma: MockPrisma = createMockPrisma();
    prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: "America/New_York" });
    prisma.order.findMany.mockResolvedValue([]);
    prisma.order.count.mockResolvedValue(0);
    prisma.order.aggregate.mockResolvedValue({ _count: { _all: 1 }, _sum: { total: "30.00" } });
    prisma.invoicePayment.groupBy.mockResolvedValue([
      { method: "CASH", _sum: { amount: "30.00" } },
    ]);
    prisma.invoicePayment.aggregate.mockResolvedValue({ _sum: { amount: "30.00" } });
    prisma.creditNote.findMany.mockResolvedValue([]);
    prisma.return.findMany.mockResolvedValue([]);
    prisma.invoicePayment.findMany.mockResolvedValue(candidates);
    return {
      prisma,
      today: () =>
        new CounterSaleTodayService(prisma as never).today({ page: 1, limit: 50 } as never, NOW),
    };
  }

  it("counts only the matching v5 PICKUP row; the counter sale's cash is counted once", async () => {
    const { today } = setup([
      pay("o-pickup", "CASH", "50.00"), // the POS hand-over's cash tender
      pay("o-pickup", "CASH", "20.00", "11111111-2222-5333-8444-555555555555"), // a deposit on it
    ]);
    const res = await today();
    expect(res.summary!.handOvers).toEqual({ count: 1, total: 50 });
    expect(res.summary!.moneyIn.cash).toBe(80); // 30 counter sale + 50 hand-over, not 100
    expect(res.summary!.cashExpectedInDrawer).toBe(80);
  });

  it("reads the candidates with the hand-over predicate, once, and the counter sale's money in unchanged", async () => {
    const { prisma, today } = setup([]);
    await today();
    expect(prisma.invoicePayment.findMany).toHaveBeenCalledTimes(1);
    const where = (prisma.invoicePayment.findMany.mock.calls[0][0] as any).where;
    expect(where.invoice.order).toMatchObject({ fulfillPath: "PICKUP", counterSale: false });
    const groupWhere = (prisma.invoicePayment.groupBy.mock.calls[0][0] as any).where;
    expect(groupWhere.invoice.order.counterSale).toBe(true);
  });
});
