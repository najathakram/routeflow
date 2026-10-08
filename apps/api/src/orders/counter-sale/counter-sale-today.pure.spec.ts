import { foldSummary, toTodaysSaleRow, type TodayOrderRecord } from "./counter-sale-today";

/**
 * Today's sales, the PURE half (rows + summary fold). No Prisma: the fixtures are the shapes the page query
 * `select`s and the three grouped queries return. Fixtures are placeholders (acme); no live-client data.
 */
type Pay = { method: string; amount: unknown; status: string };
type Ret = TodayOrderRecord["returns"][number];

const pay = (method: string, amount: number | string, status = "PAID"): Pay => ({
  method,
  amount,
  status,
});

function order(over: Partial<TodayOrderRecord> & { payments?: Pay[]; invStatus?: string } = {}) {
  const { payments = [], invStatus = "PAID", ...rest } = over;
  const rec: TodayOrderRecord = {
    id: "o-1",
    orderNumber: "1042",
    status: "DELIVERED",
    total: "24.50",
    createdAt: new Date("2026-10-07T18:14:00.000Z"),
    customerId: "c-1",
    customer: { businessName: "Acme Test Customer", isWalkIn: false },
    invoices: [{ id: "i-1", invoiceNumber: "INV-1", status: invStatus, payments }],
    returns: [],
    ...rest,
  };
  return rec;
}
const walkIn = { businessName: "Walk-in", isWalkIn: true };
const ret = (over: Partial<Ret> = {}): Ret => ({
  id: "r-1",
  returnNumber: "RET-1",
  status: "APPROVED",
  refundMethod: null,
  creditNoteId: null,
  refundAmount: null,
  creditSubtotal: "5.00",
  creditTax: "0.50",
  creditCategoryTax: "0.00",
  ...over,
});

describe("toTodaysSaleRow: payments and state (test 8)", () => {
  it("cash paid in full: one CASH method, PAID, the receipt number and invoice", () => {
    const row = toTodaysSaleRow(order({ payments: [pay("CASH", "24.50")], customer: walkIn }));
    expect(row).toMatchObject({
      orderId: "o-1",
      orderNumber: "1042",
      invoiceId: "i-1",
      invoiceNumber: "INV-1",
      total: 24.5,
      paid: 24.5,
      balanceDue: 0,
      paymentState: "PAID",
      isWalkIn: true,
      voided: false,
      createdAt: "2026-10-07T18:14:00.000Z",
    });
    expect(row.methods).toEqual([{ method: "CASH", amount: 24.5 }]);
  });

  it("CREDIT_CARD reads back as CARD and CHECK as CHECK", () => {
    expect(toTodaysSaleRow(order({ payments: [pay("CREDIT_CARD", "24.50")] })).methods).toEqual([
      { method: "CARD", amount: 24.5 },
    ]);
    expect(toTodaysSaleRow(order({ payments: [pay("CHECK", "24.50")] })).methods).toEqual([
      { method: "CHECK", amount: 24.5 },
    ]);
  });

  it("split cash + store credit: both listed, store credit is not tender, PAID", () => {
    const row = toTodaysSaleRow(
      order({ payments: [pay("CASH", "20.00"), pay("CREDIT_NOTE", "4.50")] }),
    );
    expect(row.methods).toEqual([
      { method: "CASH", amount: 20 },
      { method: "STORE_CREDIT", amount: 4.5 },
    ]);
    expect(row.paid).toBe(24.5);
    expect(row.paymentState).toBe("PAID");
  });

  it("an ADVANCE application is store credit too; ACH / ZELLE / OTHER read as OTHER", () => {
    const row = toTodaysSaleRow(
      order({ payments: [pay("ADVANCE", "10.00"), pay("ZELLE", "10.00"), pay("ACH", "4.50")] }),
    );
    expect(row.methods).toEqual([
      { method: "OTHER", amount: 14.5 },
      { method: "STORE_CREDIT", amount: 10 },
    ]);
  });

  it("a named customer with nothing paid is ON_ACCOUNT; a walk-in with nothing paid is UNPAID", () => {
    const named = toTodaysSaleRow(order({ invStatus: "SENT" }));
    expect(named.paymentState).toBe("ON_ACCOUNT");
    expect(named.balanceDue).toBe(24.5);
    expect(named.methods).toEqual([]);
    expect(toTodaysSaleRow(order({ invStatus: "SENT", customer: walkIn })).paymentState).toBe(
      "UNPAID",
    );
  });

  it("tender short of the total is PARTLY_PAID with the balance owing", () => {
    const row = toTodaysSaleRow(order({ payments: [pay("CASH", "10.00")], invStatus: "PARTIAL" }));
    expect(row.paymentState).toBe("PARTLY_PAID");
    expect(row.balanceDue).toBe(14.5);
  });

  it("VOID, DRAFT and PENDING payments are ignored", () => {
    const row = toTodaysSaleRow(
      order({
        payments: [
          pay("CASH", "24.50", "VOID"),
          pay("CASH", "5.00", "DRAFT"),
          pay("CHECK", "7.00", "PENDING"),
        ],
        invStatus: "SENT",
      }),
    );
    expect(row.paid).toBe(0);
    expect(row.methods).toEqual([]);
  });

  it("a cancelled order is voided; so is a sale whose every invoice is VOID / WRITTEN_OFF", () => {
    expect(toTodaysSaleRow(order({ status: "CANCELLED" })).voided).toBe(true);
    expect(toTodaysSaleRow(order({ invStatus: "VOID" })).voided).toBe(true);
    expect(toTodaysSaleRow(order({ invStatus: "WRITTEN_OFF" })).voided).toBe(true);
    expect(toTodaysSaleRow(order({ invStatus: "PAID" })).voided).toBe(false);
  });

  it("payments on a VOID invoice never count toward paid", () => {
    const row = toTodaysSaleRow(
      order({
        invoices: [
          { id: "i-void", invoiceNumber: "INV-V", status: "VOID", payments: [pay("CASH", "99")] },
          {
            id: "i-live",
            invoiceNumber: "INV-L",
            status: "PAID",
            payments: [pay("CASH", "24.50")],
          },
        ],
      }),
    );
    expect(row.paid).toBe(24.5);
    expect(row.invoiceId).toBe("i-live");
    expect(row.voided).toBe(false);
  });

  it("0.1 + 0.2 style amounts come out rounded to cents", () => {
    const row = toTodaysSaleRow(
      order({ total: "0.30", payments: [pay("CASH", "0.1"), pay("CHECK", "0.2")] }),
    );
    expect(row.paid).toBe(0.3);
    expect(row.balanceDue).toBe(0);
  });

  it("an order with no invoice reads empty ids and an unpaid balance, not voided", () => {
    const row = toTodaysSaleRow(order({ invoices: [], customer: walkIn }));
    expect(row).toMatchObject({ invoiceId: null, invoiceNumber: null, voided: false, paid: 0 });
    expect(row.paymentState).toBe("UNPAID");
  });
});

describe("toTodaysSaleRow: returns (test 9)", () => {
  it("none: NONE with 0", () => {
    expect(toTodaysSaleRow(order()).returned).toEqual({ amount: 0, state: "NONE", returns: [] });
  });

  it("one partial return: PARTLY with its priced credit (subtotal + tax + category tax)", () => {
    const row = toTodaysSaleRow(
      order({
        returns: [ret({ refundMethod: "CREDIT_NOTE", creditCategoryTax: "0.25" })],
      }),
    );
    expect(row.returned.state).toBe("PARTLY");
    expect(row.returned.amount).toBe(5.75);
    expect(row.returned.returns).toEqual([
      {
        id: "r-1",
        returnNumber: "RET-1",
        status: "APPROVED",
        resolution: "STORE_CREDIT",
        amount: 5.75,
      },
    ]);
  });

  it("returns summing to the total: FULL", () => {
    const row = toTodaysSaleRow(
      order({
        total: "11.00",
        returns: [
          ret({ id: "r-1", refundMethod: "CREDIT_NOTE" }),
          ret({ id: "r-2", refundMethod: "EXTERNAL_REFUND", status: "REFUNDED" }),
        ],
      }),
    );
    expect(row.returned.amount).toBe(11);
    expect(row.returned.state).toBe("FULL");
  });

  it("REJECTED and CANCELLED returns are ignored", () => {
    const row = toTodaysSaleRow(
      order({
        returns: [ret({ status: "REJECTED" }), ret({ id: "r-2", status: "CANCELLED" })],
      }),
    );
    expect(row.returned).toEqual({ amount: 0, state: "NONE", returns: [] });
  });

  it("an unresolved return is PENDING and wins over a resolved one", () => {
    const row = toTodaysSaleRow(
      order({
        returns: [
          ret({ id: "r-1", refundMethod: "CREDIT_NOTE" }),
          ret({ id: "r-2", status: "PENDING", refundMethod: null }),
        ],
      }),
    );
    expect(row.returned.state).toBe("PENDING");
    expect(row.returned.returns.map((r) => r.resolution)).toEqual(["STORE_CREDIT", "PENDING"]);
  });

  it("resolution: EXTERNAL_REFUND is REFUND, a credit note id is STORE_CREDIT, a settled return with neither is null", () => {
    const res = (r: Partial<Ret>) =>
      toTodaysSaleRow(order({ returns: [ret(r)] })).returned.returns[0].resolution;
    expect(res({ refundMethod: "EXTERNAL_REFUND", status: "REFUNDED" })).toBe("REFUND");
    expect(res({ refundMethod: null, creditNoteId: "cn-1", status: "PROCESSED" })).toBe(
      "STORE_CREDIT",
    );
    expect(res({ refundMethod: null, status: "PROCESSED" })).toBeNull();
    expect(res({ refundMethod: null, status: "PENDING" })).toBe("PENDING");
  });

  it("with no priced split the stored refund amount is the amount", () => {
    const row = toTodaysSaleRow(
      order({
        returns: [
          ret({
            refundMethod: "EXTERNAL_REFUND",
            creditSubtotal: null,
            creditTax: null,
            creditCategoryTax: null,
            refundAmount: "3.25",
          }),
        ],
      }),
    );
    expect(row.returned.amount).toBe(3.25);
  });
});

describe("foldSummary (tests 10 and 11)", () => {
  const sales = { _count: { _all: 12 }, _sum: { total: "284.50" } };

  it("sales count/total; money in by method; store credit and on account are NOT money in", () => {
    const s = foldSummary({
      sales,
      payments: [
        { method: "CASH", _sum: { amount: "100.00" } },
        { method: "CREDIT_CARD", _sum: { amount: "144.50" } },
        { method: "CHECK", _sum: { amount: "20.00" } },
        { method: "CREDIT_NOTE", _sum: { amount: "5.00" } },
        { method: "ADVANCE", _sum: { amount: "3.00" } },
        { method: "ZELLE", _sum: { amount: "2.00" } },
      ],
      returns: [],
    });
    expect(s.sales).toEqual({ count: 12, total: 284.5 });
    expect(s.moneyIn).toEqual({ cash: 100, card: 144.5, check: 20, other: 2, total: 266.5 });
    expect(s.storeCreditUsed).toBe(8);
    // 284.50 - 266.50 - 8.00
    expect(s.onAccount).toBe(10);
    expect(s.cashExpectedInDrawer).toBe(100);
    expect(s.netCollected).toBe(266.5);
  });

  it("0.1 + 0.2 style group sums come out as cents, never 0.30000000000000004", () => {
    const s = foldSummary({
      sales: { _count: { _all: 2 }, _sum: { total: 0.3 } },
      payments: [
        { method: "CASH", _sum: { amount: 0.1 } },
        { method: "CASH", _sum: { amount: 0.2 } },
      ],
      returns: [],
    });
    expect(s.moneyIn.cash).toBe(0.3);
    expect(s.moneyIn.total).toBe(0.3);
    expect(s.onAccount).toBe(0);
  });

  it("an empty day is all zeros (the aggregate's empty shape: null sum, no groups)", () => {
    const s = foldSummary({
      sales: { _count: {}, _sum: { total: null } },
      payments: [],
      returns: [],
    });
    expect(s).toEqual({
      sales: { count: 0, total: 0 },
      moneyIn: { cash: 0, card: 0, check: 0, other: 0, total: 0 },
      storeCreditUsed: 0,
      onAccount: 0,
      refunds: { count: 0, cash: 0, card: 0, check: 0, other: 0, total: 0, tenderKnown: false },
      storeCreditIssued: { count: 0, amount: 0 },
      cashExpectedInDrawer: 0,
      netCollected: 0,
    });
  });

  it("refunds by refund date lower netCollected; the tender is not stored, so they sit in `other` and cash expected does not subtract them", () => {
    const s = foldSummary({
      sales,
      payments: [{ method: "CASH", _sum: { amount: "120.00" } }],
      returns: [
        {
          refundMethod: "EXTERNAL_REFUND",
          _count: { _all: 2 },
          _sum: { refundAmount: "16.00" },
        },
      ],
    });
    expect(s.refunds).toEqual({
      count: 2,
      cash: 0,
      card: 0,
      check: 0,
      other: 16,
      total: 16,
      tenderKnown: false,
    });
    expect(s.netCollected).toBe(104);
    expect(s.cashExpectedInDrawer).toBe(120);
  });

  it("store credit issued counts the priced credit of CREDIT_NOTE returns and is not a refund", () => {
    const s = foldSummary({
      sales,
      payments: [],
      returns: [
        {
          refundMethod: "CREDIT_NOTE",
          _count: { _all: 3 },
          _sum: { creditSubtotal: "10.00", creditTax: "0.80", creditCategoryTax: "0.20" },
        },
      ],
    });
    expect(s.storeCreditIssued).toEqual({ count: 3, amount: 11 });
    expect(s.refunds.total).toBe(0);
    expect(s.netCollected).toBe(0);
  });
});
