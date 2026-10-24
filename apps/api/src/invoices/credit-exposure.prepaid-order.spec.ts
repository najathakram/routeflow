import { InvoiceStatus } from "@prisma/client";
import {
  NO_RECEIVED_PAYMENT_INVOICE_STATUSES,
  UNSETTLED_INVOICE_STATUSES,
  computeCreditExposure,
  editedOrderContribution,
  loadCreditExposure,
  OPEN_ORDER_STATUSES,
  orderPaidAmount,
  orderUnsettledOutstanding,
  SETTLED_COVERING_STATUSES,
  type ExposureInvoice,
} from "./credit-exposure";

/**
 * B577 — an OPEN order fully prepaid by a PAID invoice must not count again. The reader used to drop
 * every PAID invoice, so the order looked entirely "unbilled" and its whole total re-entered the hard
 * credit block. Rule: exposure per open order = max(0, order total − Σ that order's non-VOID
 * invoices, issued or paid); invoice BALANCES are still counted separately (a PAID invoice has none).
 */

const orderRef = (id: string, status: string, total: unknown) => ({ id, status, total });
const inv = (o: Partial<ExposureInvoice> & { total: unknown }): ExposureInvoice => ({
  status: "SENT",
  orderId: null,
  payments: [],
  order: null,
  ...o,
});
/** A PAID invoice for `orderId`, fully paid (balance 0) — what the reader now also returns. */
const paid = (orderId: string, total: number, status = "PAID") =>
  inv({
    total,
    status,
    orderId,
    order: orderRef(orderId, "CONFIRMED", 100),
    payments: [{ amount: total, status: "PAID" }],
  });
const open = (id: string, total: number) => ({ id, total });

describe("computeCreditExposure — settled invoices COVER their order (B577)", () => {
  it("a fully prepaid OPEN order counts 0 (was: its whole total again)", () => {
    const r = computeCreditExposure({
      invoices: [paid("o1", 100)],
      openOrders: [open("o1", 100)],
    });
    expect(r).toEqual({
      invoiceExposure: 0,
      uninvoicedOrderExposure: 0,
      counted: 0,
      pendingExposure: 0,
    });
  });

  it("a partially prepaid OPEN order counts only the uncovered remainder", () => {
    const r = computeCreditExposure({
      invoices: [paid("o1", 60)],
      openOrders: [open("o1", 100)],
    });
    expect(r.uninvoicedOrderExposure).toBe(40);
    expect(r.invoiceExposure).toBe(0);
    expect(r.counted).toBe(40);
  });

  it("control: an OPEN order with no invoice at all still counts its whole total", () => {
    const r = computeCreditExposure({ invoices: [], openOrders: [open("o1", 100)] });
    expect(r).toMatchObject({ uninvoicedOrderExposure: 100, invoiceExposure: 0, counted: 100 });
  });

  it("two PAID invoices cover cumulatively", () => {
    const r = computeCreditExposure({
      invoices: [paid("o1", 30), paid("o1", 45)],
      openOrders: [open("o1", 100)],
    });
    expect(r.counted).toBe(25);
  });

  it("PAID + a still-unpaid issued invoice on one order: the balance counts once, the remainder is 0", () => {
    const r = computeCreditExposure({
      invoices: [
        paid("o1", 60),
        inv({ total: 40, status: "SENT", orderId: "o1", order: orderRef("o1", "CONFIRMED", 100) }),
      ],
      openOrders: [open("o1", 100)],
    });
    // 40 open balance; 100 − 60 − 40 = 0 unbilled — never 100, never 140.
    expect(r).toMatchObject({ invoiceExposure: 40, uninvoicedOrderExposure: 0, counted: 40 });
  });

  it("a PAID invoice larger than the order floors the remainder at 0 (never negative)", () => {
    const r = computeCreditExposure({
      invoices: [paid("o1", 130)],
      openOrders: [open("o1", 100)],
    });
    expect(r.counted).toBe(0);
  });

  it("a WRITTEN_OFF invoice covers NOTHING — its order stays counted (ruling: a write-off means we gave up collecting, the strongest reason to withhold credit)", () => {
    const r = computeCreditExposure({
      invoices: [paid("o1", 100, "WRITTEN_OFF")],
      openOrders: [open("o1", 100)],
    });
    expect(r.counted).toBe(100);
  });

  it("a VOID invoice covers NOTHING — its order's value is exposure again", () => {
    const r = computeCreditExposure({
      invoices: [paid("o1", 100, "VOID")],
      openOrders: [open("o1", 100)],
    });
    expect(r.counted).toBe(100);
  });

  it("cover is per order: another order's PAID invoice does not reduce this one", () => {
    const r = computeCreditExposure({
      invoices: [paid("o2", 100)],
      openOrders: [open("o1", 100), open("o2", 100)],
    });
    expect(r).toMatchObject({ uninvoicedOrderExposure: 100, counted: 100 }); // o1 in full, o2 covered
  });

  it("a standalone PAID invoice (no order) covers nothing and is never counted", () => {
    const r = computeCreditExposure({
      invoices: [inv({ total: 100, status: "PAID", orderId: null })],
      openOrders: [open("o1", 100)],
    });
    expect(r.counted).toBe(100);
  });

  it("a PAID invoice on a DELIVERED order with no draft is ignored (no remainder is ever added there)", () => {
    const r = computeCreditExposure({
      invoices: [
        inv({
          total: 100,
          status: "PAID",
          orderId: "d1",
          order: orderRef("d1", "DELIVERED", 100),
          payments: [{ amount: 100, status: "PAID" }],
        }),
      ],
      openOrders: [],
    });
    expect(r.counted).toBe(0);
  });

  it("core only: a PAID invoice covers its share of a DELIVERED order that carries a backed DRAFT (same max rule; the reader supplies OPEN orders' covers only)", () => {
    const delivered = orderRef("d1", "DELIVERED", 100);
    const r = computeCreditExposure({
      invoices: [
        inv({ total: 60, status: "PAID", orderId: "d1", order: delivered }),
        inv({ total: 40, status: "DRAFT", orderId: "d1", order: delivered }),
      ],
      openOrders: [],
    });
    // 40 draft balance; 100 − 60 − 40 = 0 remainder. Without the cover it would count 100.
    expect(r).toMatchObject({ invoiceExposure: 40, uninvoicedOrderExposure: 0, counted: 40 });
  });

  it("excludeOrderId: the edited order contributes nothing (the caller supplies its projected total); another order's cover still applies", () => {
    const r = computeCreditExposure({
      invoices: [paid("edit", 100), paid("o2", 50)],
      openOrders: [open("edit", 100), open("o2", 80)],
      excludeOrderId: "edit",
    });
    expect(r.counted).toBe(30); // only o2's uncovered 30 — not 0 and not 110
  });
});

describe("SETTLED_COVERING_STATUSES and the reader (B577)", () => {
  it("covers PAID only — never VOID or WRITTEN_OFF, never a live or draft status", () => {
    expect([...SETTLED_COVERING_STATUSES]).toEqual(["PAID"]);
  });

  it("the reader also selects the PAID invoices of OPEN orders only (bounded, never lifetime history), scoped by customer", async () => {
    const db = {
      invoice: { findMany: jest.fn().mockResolvedValue([]) },
      order: { findMany: jest.fn().mockResolvedValue([]) },
    };
    await loadCreditExposure(db, "cust-1");

    const args = db.invoice.findMany.mock.calls[0][0];
    expect(args.where.customerId).toBe("cust-1");
    expect(args.where.OR).toHaveLength(2);
    const cover = args.where.OR[1];
    expect(new Set(cover.status.in)).toEqual(new Set(SETTLED_COVERING_STATUSES));
    expect(new Set(cover.order.status.in)).toEqual(new Set(OPEN_ORDER_STATUSES));
    // delivered/terminal orders must NOT be read: their paid history would grow with every credit check
    expect(cover.order.status.in).not.toContain("DELIVERED");
    expect(cover.order.status.in).not.toContain("PARTIALLY_DELIVERED");
  });

  it("end to end through the reader: the open order's PAID invoice comes back and the order counts 0", async () => {
    const db = {
      invoice: { findMany: jest.fn().mockResolvedValue([paid("o1", 100)]) },
      order: { findMany: jest.fn().mockResolvedValue([open("o1", 100)]) },
    };
    await expect(loadCreditExposure(db, "cust-1")).resolves.toMatchObject({ counted: 0 });
  });
});

describe("orderPaidAmount — money already received toward the EDITED order (B577 follow-up)", () => {
  const pay = (amount: number, status = "PAID", method?: string) => ({ amount, status, method });
  const forOrder = (
    total: number,
    status: string,
    payments: { amount: number; status: string; method?: string }[],
    orderId = "o1",
  ) => inv({ total, status, orderId, payments });

  it("B421: a CREDIT_NOTE application is never money received — a goodwill credit note that flips an invoice to PAID covers NOTHING; cash and ADVANCE do", () => {
    const paidBy = (...p: ReturnType<typeof pay>[]) =>
      orderPaidAmount([forOrder(100, "PAID", p)], "o1");
    expect(paidBy(pay(100, "PAID", "CREDIT_NOTE"))).toBe(0);
    expect(paidBy(pay(60, "PAID", "ADVANCE"))).toBe(60);
    expect(paidBy(pay(40, "PAID", "CASH"), pay(60, "PAID", "CREDIT_NOTE"))).toBe(40);
  });

  it("counts only confirmed payments, capped at the invoice total (an over-payment's excess is credit, not cover)", () => {
    expect(orderPaidAmount([forOrder(100, "PAID", [pay(100)])], "o1")).toBe(100);
    expect(orderPaidAmount([forOrder(1000, "PARTIAL", [pay(400), pay(200)])], "o1")).toBe(600);
    expect(orderPaidAmount([forOrder(100, "PAID", [pay(130)])], "o1")).toBe(100);
  });

  it("sums across the order's invoices and ignores every other order", () => {
    const rows = [
      forOrder(100, "PAID", [pay(100)]),
      forOrder(50, "PARTIAL", [pay(20)]),
      forOrder(900, "PAID", [pay(900)], "other"),
    ];
    expect(orderPaidAmount(rows, "o1")).toBe(120);
  });

  it("is CONSERVATIVE: only confirmed (PAID) payments on issued-or-paid invoices loosen the guard", () => {
    const rows = [
      forOrder(100, "SENT", [pay(60, "DRAFT"), pay(30, "PENDING"), pay(10, "VOID")]),
      forOrder(100, "DRAFT", [pay(100)]), // an unissued draft's payment is not received money
      forOrder(100, "VOID", [pay(100)]),
      forOrder(100, "WRITTEN_OFF", [pay(100)]),
      { total: 100, status: "PAID", orderId: "o1", order: null } as any, // no payments relation: 0, not a TypeError
    ];
    expect(orderPaidAmount(rows, "o1")).toBe(0);
  });
});

describe("orderUnsettledOutstanding + editedOrderContribution — the floor under an edited order (B577 follow-up)", () => {
  const partial = (total: number, paidAmount: number, orderId = "o1") =>
    inv({ total, status: "PARTIAL", orderId, payments: [{ amount: paidAmount, status: "PAID" }] });

  it("every ISSUED unsettled invoice of THIS order owes its balance — PAID, DRAFT and other orders nothing; never negative when over-paid", () => {
    const rows = [
      partial(200, 50), // owes 150
      partial(80, 20, "other"),
      inv({ total: 100, status: "SENT", orderId: "o1" }),
      inv({ total: 60, status: "VIEWED", orderId: "o1" }),
      inv({ total: 40, status: "OVERDUE", orderId: "o1" }),
      inv({
        total: 100,
        status: "PAID",
        orderId: "o1",
        payments: [{ amount: 100, status: "PAID" }],
      }),
      inv({ total: 100, status: "DRAFT", orderId: "o1" }),
    ];
    expect(orderUnsettledOutstanding(rows, "o1")).toBe(350);
    expect(orderUnsettledOutstanding([partial(100, 130)], "o1")).toBe(0);
  });

  it.each([
    // projected, paid, unsettledOwed, survives → contribution
    [15, 15, 0, false, 0], // fully prepaid → nothing
    [15, 50, 0, false, 0], // paid MORE than projected → floored at 0, never negative
    [15, 5, 0, false, 10], // half paid → the unpaid part
    [100, 0, 0, false, 100], // nothing paid → the projected total, as before B577
    [15, 50, 150, true, 150], // a PARTIAL invoice that SURVIVES still owes 150 → its balance wins
    [15, 50, 150, false, 15], // ... but if the edit REWRITES it, only up to the projected total
    [1050, 1000, 1000, true, 1000], // review: PAID batch + a surviving OVERDUE batch → its balance, not 50
    [600, 300, 700, false, 600], // review #2: fully invoiced PARTIAL 1000/300 cut to 600 → 600, not 700
  ])(
    "editedOrderContribution(projected %p, paid %p, unsettled owes %p, survives %p) = %p",
    (p, paid, unsettled, survives, want) => {
      expect(editedOrderContribution(p, paid, unsettled, survives)).toBe(want);
    },
  );
});

describe("loadCreditExposure with an edited order (B577 follow-up)", () => {
  const makeDb = (invoices: unknown[]) => ({
    invoice: { findMany: jest.fn().mockResolvedValue(invoices) },
    order: { findMany: jest.fn().mockResolvedValue([]) },
  });

  it("without excludeOrderId the result has exactly the four figures and the query has two branches", async () => {
    const db = makeDb([]);
    const r = await loadCreditExposure(db, "cust-1");
    expect(Object.keys(r).sort()).toEqual(
      ["counted", "invoiceExposure", "pendingExposure", "uninvoicedOrderExposure"].sort(),
    );
    expect(db.invoice.findMany.mock.calls[0][0].where.OR).toHaveLength(2);
  });

  it("with excludeOrderId it also reads that order's PAID invoices (any order status) and reports excludedOrderPaid", async () => {
    const db = makeDb([
      // the edited order's own PAID invoice — read by the extra branch even if the order is delivered
      {
        total: 900,
        status: "PAID",
        orderId: "edit",
        order: orderRef("edit", "DELIVERED", 900),
        payments: [{ amount: 900, status: "PAID" }],
      },
    ]);
    const r = await loadCreditExposure(db, "cust-1", { excludeOrderId: "edit" });

    const branches = db.invoice.findMany.mock.calls[0][0].where.OR;
    expect(branches).toHaveLength(3);
    expect(branches[2]).toEqual({ status: { in: ["PAID"] }, orderId: "edit" });
    expect(r.excludedOrderPaid).toBe(900);
    expect(r.excludedOrderUnsettledOutstanding).toBe(0);
    expect(r.counted).toBe(0); // the edited order's invoices never enter the other buckets
  });
});

it("the status sets are pinned EXHAUSTIVELY against InvoiceStatus: a NEW status must not silently drop out of the floor", () => {
  const classified = [
    ...UNSETTLED_INVOICE_STATUSES,
    "PAID",
    ...NO_RECEIVED_PAYMENT_INVOICE_STATUSES,
  ];
  expect(classified.sort()).toEqual(Object.values(InvoiceStatus).sort());
});
