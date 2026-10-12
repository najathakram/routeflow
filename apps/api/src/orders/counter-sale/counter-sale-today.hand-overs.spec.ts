import { FulfillPath } from "@prisma/client";
import { createMockPrisma, type MockPrisma } from "../../testing/prisma-mock";
import {
  HAND_OVER_ROWS_MAX,
  foldSummary,
  handOverCandidateSelect,
  handOverCandidatesWhere,
  handOverPayments,
  salePaymentsWhere,
  toHandOverRows,
  type HandOverPayment,
} from "./counter-sale-today";
import { CounterSaleTodayService } from "./counter-sale-today.service";
import { pickupTenderGroupId } from "./pickup-tender-group";
import { isCounterTenderRow } from "./counter-tender-row";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

describe("handOverPayments — ONE tender predicate with the day close (row 342)", () => {
  const POS = { counterSale: false } as const;
  const rows = [
    { ...pay("o-1", "CASH", "50.00"), status: "PAID" },
    { ...pay("o-2", "CHECK", "40.00"), status: "PAID", checkStatus: "RECORDED" },
    { ...pay("o-3", "CHECK", "30.00"), status: "PAID", checkStatus: "DEPOSITED" }, // the bank has it
    { ...pay("o-4", "ACH", "25.00"), status: "PAID" }, // not a till tender method
    { ...pay("o-5", "CASH", "20.00"), status: "PENDING" },
  ];

  it("a hand-over row is exactly what isCounterTenderRow says is the pickup tender", () => {
    const kept = new Set(handOverPayments(rows).map((h) => h.orderId));
    for (const r of rows) {
      const orderId = r.invoice.orderId;
      expect(kept.has(orderId)).toBe(isCounterTenderRow(orderId, r, POS));
    }
  });

  it("a deposited check and a non-till method are not hand-over rows (day close reads them as foreign)", () => {
    const kept = handOverPayments(rows).map((h) => h.orderId);
    expect(kept).toEqual(expect.arrayContaining(["o-1", "o-2"]));
    expect(kept).not.toContain("o-3");
    expect(kept).not.toContain("o-4");
  });

  it("the sale-day sources hold no second copy of the group-id rule", () => {
    for (const f of ["counter-sale-today.ts", "day-close/day-close-facts.ts"]) {
      const src = readFileSync(join(__dirname, f), "utf8");
      expect(src).not.toMatch(/===\s*pickupTenderGroupId\(/);
    }
    // Today's rows read the full predicate; the day close's facts SELECT by its group clause and the fold decides the bucket
    expect(readFileSync(join(__dirname, "counter-sale-today.ts"), "utf8")).toMatch(
      /isCounterTenderRow/,
    );
    expect(readFileSync(join(__dirname, "day-close/day-close-facts.ts"), "utf8")).toMatch(
      /isCounterTenderGroup/,
    );
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

// ─── row 342: the hand-over ROWS ──────────────────────────────────────────────────────────────────

const order = (
  over: Partial<NonNullable<HandOverPayment["order"]>> = {},
): NonNullable<HandOverPayment["order"]> => ({
  orderNumber: "SO-1",
  registerKey: "reg-2",
  soldBy: { username: "pat" },
  customer: { businessName: "Acme Test Customer" },
  ...over,
});
const tender = (
  orderId: string,
  method: string,
  amount: string,
  paidAt: string,
  o: HandOverPayment["order"] = order(),
): HandOverPayment => ({ method, amount, orderId, paidAt: new Date(paidAt), order: o });

describe("handOverCandidateSelect: the row fields ride the same read", () => {
  it("selects when, the order number, register, the cashier's username only and the customer name", () => {
    expect(handOverCandidateSelect).toMatchObject({
      method: true,
      amount: true,
      paidAt: true,
      paymentGroupId: true,
    });
    const o = handOverCandidateSelect.invoice.select.order.select;
    expect(o).toEqual({
      orderNumber: true,
      registerKey: true,
      soldBy: { select: { username: true } }, // never the email or any other user column
      customer: { select: { businessName: true } },
    });
  });

  it("handOverPayments carries paidAt and the order through for a matching tender", () => {
    const paidAt = new Date("2026-10-07T15:00:00.000Z");
    const [h] = handOverPayments([
      {
        method: "CASH",
        amount: "5.00",
        paymentGroupId: pickupTenderGroupId("o-1"),
        paidAt,
        invoice: { orderId: "o-1", order: order() },
      },
    ]);
    expect(h).toMatchObject({ orderId: "o-1", paidAt, order: { registerKey: "reg-2" } });
  });
});

describe("toHandOverRows", () => {
  it("groups by order: amount is the rounded sum, methods by the till's own buckets, paidAt the latest", () => {
    const rows = toHandOverRows([
      tender("o-1", "CASH", "0.10", "2026-10-07T14:00:00.000Z"),
      tender("o-1", "CASH", "0.20", "2026-10-07T15:30:00.000Z"),
      tender("o-1", "CREDIT_CARD", "9.70", "2026-10-07T13:00:00.000Z"),
      tender("o-1", "ADVANCE", "5.00", "2026-10-07T13:00:00.000Z"),
    ]);
    expect(rows).toEqual([
      {
        orderId: "o-1",
        orderNumber: "SO-1",
        customerName: "Acme Test Customer",
        paidAt: "2026-10-07T15:30:00.000Z",
        amount: 15,
        methods: [
          { method: "CASH", amount: 0.3 }, // 0.1 + 0.2 is float noise unrounded
          { method: "CARD", amount: 9.7 },
          { method: "STORE_CREDIT", amount: 5 },
        ],
        registerKey: "reg-2",
        handedOverBy: "pat",
      },
    ]);
  });

  it("an unstamped register reads 'main' and an unstamped / email-like cashier is null", () => {
    const rows = toHandOverRows([
      tender(
        "o-1",
        "CASH",
        "1.00",
        "2026-10-07T10:00:00.000Z",
        order({ registerKey: null, soldBy: null }),
      ),
      tender(
        "o-2",
        "CASH",
        "1.00",
        "2026-10-07T11:00:00.000Z",
        order({ registerKey: "  ", soldBy: { username: "pat@example.test" } }),
      ),
    ]);
    expect(rows.map((r) => [r.orderId, r.registerKey, r.handedOverBy])).toEqual([
      ["o-2", "main", null],
      ["o-1", "main", null],
    ]);
  });

  it("is newest first, with the order id as the tie-break", () => {
    const rows = toHandOverRows([
      tender("o-b", "CASH", "1.00", "2026-10-07T10:00:00.000Z"),
      tender("o-c", "CASH", "1.00", "2026-10-07T12:00:00.000Z"),
      tender("o-a", "CASH", "1.00", "2026-10-07T10:00:00.000Z"),
    ]);
    expect(rows.map((r) => r.orderId)).toEqual(["o-c", "o-a", "o-b"]);
  });

  it("tolerates a hand-built tender with no order or paidAt (empty strings, never a throw)", () => {
    const [r] = toHandOverRows([{ method: "CASH", amount: "3.00", orderId: "o-1" }]);
    expect(r).toMatchObject({
      orderNumber: "",
      customerName: "",
      amount: 3,
      registerKey: "main",
      handedOverBy: null,
    });
  });

  it("is bounded to HAND_OVER_ROWS_MAX, keeping the newest", () => {
    const many = Array.from({ length: HAND_OVER_ROWS_MAX + 5 }, (_, i) =>
      tender(
        `o-${String(i).padStart(3, "0")}`,
        "CASH",
        "1.00",
        new Date(Date.UTC(2026, 9, 7, 0, 0, i)).toISOString(),
      ),
    );
    const rows = toHandOverRows(many);
    expect(rows).toHaveLength(HAND_OVER_ROWS_MAX);
    expect(rows[0]!.orderId).toBe(`o-${String(HAND_OVER_ROWS_MAX + 4).padStart(3, "0")}`);
  });

  it("agrees with foldSummary: the rows' order count and amounts ARE the summary's hand-over line", () => {
    const handOvers = [
      tender("o-1", "CASH", "30.00", "2026-10-07T10:00:00.000Z"),
      tender("o-1", "CASH", "10.00", "2026-10-07T10:05:00.000Z"),
      tender("o-2", "CREDIT_CARD", "12.50", "2026-10-07T11:00:00.000Z"),
    ];
    const rows = toHandOverRows(handOvers);
    const s = foldSummary({
      sales: { _count: { _all: 0 }, _sum: { total: null } },
      payments: [],
      paidOnSales: none,
      returns: [],
      handOvers,
    });
    expect(rows).toHaveLength(s.handOvers.count);
    expect(rows.reduce((t, r) => Math.round((t + r.amount) * 100) / 100, 0)).toBe(
      s.handOvers.total,
    );
  });
});

describe("CounterSaleTodayService: handOverRows on page 1, none on page 2", () => {
  const candidates = () => [
    {
      ...pay("o-pickup", "CASH", "50.00"),
      paidAt: new Date("2026-10-07T14:00:00.000Z"),
      invoice: {
        orderId: "o-pickup",
        order: order({ orderNumber: "SO-77", registerKey: null, soldBy: { username: "pat" } }),
      },
    },
    // a deposit on the same invoice: not the hand-over's own tender, so not a row and not in the line
    {
      ...pay("o-pickup", "CASH", "20.00", "11111111-2222-5333-8444-555555555555"),
      paidAt: new Date("2026-10-07T13:00:00.000Z"),
      invoice: { orderId: "o-pickup", order: order() },
    },
  ];
  function setup() {
    const prisma: MockPrisma = createMockPrisma();
    prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: "America/New_York" });
    prisma.order.findMany.mockResolvedValue([]);
    prisma.order.count.mockResolvedValue(0);
    prisma.order.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { total: null } });
    prisma.invoicePayment.groupBy.mockResolvedValue([]);
    prisma.invoicePayment.aggregate.mockResolvedValue({ _sum: { amount: null } });
    prisma.creditNote.findMany.mockResolvedValue([]);
    prisma.return.findMany.mockResolvedValue([]);
    prisma.invoicePayment.findMany.mockResolvedValue(candidates());
    return prisma;
  }
  const call = (prisma: MockPrisma, page: number) =>
    new CounterSaleTodayService(prisma as never).today({ page, limit: 50 } as never, NOW);

  it("page 1: the rows are the summary's hand-overs, from the ONE candidate read", async () => {
    const prisma = setup();
    const res = await call(prisma, 1);
    expect(res.handOverRows).toEqual([
      {
        orderId: "o-pickup",
        orderNumber: "SO-77",
        customerName: "Acme Test Customer",
        paidAt: "2026-10-07T14:00:00.000Z",
        amount: 50,
        methods: [{ method: "CASH", amount: 50 }],
        registerKey: "main",
        handedOverBy: "pat",
      },
    ]);
    expect(res.summary!.handOvers).toEqual({ count: 1, total: 50 });
    expect(prisma.invoicePayment.findMany).toHaveBeenCalledTimes(1);
    expect((prisma.invoicePayment.findMany.mock.calls[0][0] as any).select).toBe(
      handOverCandidateSelect,
    );
  });

  it("page 2: no rows, no summary, no candidate read", async () => {
    const prisma = setup();
    const res = await call(prisma, 2);
    expect(res.handOverRows).toEqual([]);
    expect(res.summary).toBeNull();
    expect(prisma.invoicePayment.findMany).not.toHaveBeenCalled();
  });
});
