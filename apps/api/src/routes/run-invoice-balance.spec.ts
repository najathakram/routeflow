import {
  attachPayableInvoices,
  groupPayableInvoicesByOrder,
  payableInvoiceFindManyArgs,
  withPayableInvoices,
  withPayableInvoicesForRuns,
  type RawInvoiceForBalance,
} from "./run-invoice-balance";

function row(over: Partial<RawInvoiceForBalance>): RawInvoiceForBalance {
  return {
    id: "inv-1",
    orderId: "order-1",
    status: "SENT",
    total: 100,
    depositPercent: null,
    deliveryBatchId: null,
    payments: [],
    ...over,
  };
}

describe("payableInvoiceFindManyArgs", () => {
  it("filters by orderId IN the given ids and excludes VOID only (not PAYABLE-only) — isDepositMirror needs the full non-void set", () => {
    const args = payableInvoiceFindManyArgs(["o1", "o2"]);
    expect(args.where).toEqual({ orderId: { in: ["o1", "o2"] }, status: { not: "VOID" } });
  });

  it("orders oldest-first, matching recordDeliveryPaymentInTx", () => {
    const args = payableInvoiceFindManyArgs(["o1"]);
    expect(args.orderBy).toEqual([{ createdAt: "asc" }, { invoiceNumber: "asc" }]);
  });

  it("selects the fields isDepositMirror/balanceDue need, and confirmed-only payments — no unfiltered payments read", () => {
    const args = payableInvoiceFindManyArgs(["o1"]);
    expect(args.select).toEqual(
      expect.objectContaining({
        id: true,
        orderId: true,
        status: true,
        total: true,
        depositPercent: true,
        deliveryBatchId: true,
      }),
    );
    expect(args.select.payments.where).toBeDefined();
  });
});

describe("groupPayableInvoicesByOrder", () => {
  it("a SENT invoice with a confirmed partial payment -> balanceDue = total - paid, never total", () => {
    const byOrder = groupPayableInvoicesByOrder([
      row({
        id: "i1",
        orderId: "o1",
        status: "SENT",
        total: 100,
        payments: [{ amount: 40, status: "PAID" }],
      }),
    ]);
    expect(byOrder["o1"]).toEqual([
      { id: "i1", status: "SENT", total: 100, balanceDue: 60, isDepositMirror: false },
    ]);
  });

  it("a PARTIAL invoice uses the same formula", () => {
    const byOrder = groupPayableInvoicesByOrder([
      row({ id: "i1", status: "PARTIAL", total: 50, payments: [{ amount: 10, status: "PAID" }] }),
    ]);
    expect(byOrder["order-1"]![0]!.balanceDue).toBe(40);
  });

  it("an OVERDUE invoice uses the same formula (still PAYABLE)", () => {
    const byOrder = groupPayableInvoicesByOrder([row({ status: "OVERDUE", total: 30 })]);
    expect(byOrder["order-1"]![0]!.balanceDue).toBe(30);
  });

  it("B822: a DRAFT with a confirmed payment (an applied advance) nets down too — uniform formula, no per-status assumption", () => {
    const byOrder = groupPayableInvoicesByOrder([
      row({ status: "DRAFT", total: 100, payments: [{ amount: 25, status: "PAID" }] }),
    ]);
    expect(byOrder["order-1"]![0]!).toEqual({
      id: "inv-1",
      status: "DRAFT",
      total: 100,
      balanceDue: 75,
      isDepositMirror: false,
    });
  });

  it("a DRAFT with no payments -> balanceDue === total, byte-identical to the pre-B810 number", () => {
    const byOrder = groupPayableInvoicesByOrder([row({ status: "DRAFT", total: 42 })]);
    expect(byOrder["order-1"]![0]!.balanceDue).toBe(42);
  });

  it("clamps at 0 rather than going negative on an overpayment", () => {
    const byOrder = groupPayableInvoicesByOrder([
      row({ total: 50, payments: [{ amount: 60, status: "PAID" }] }),
    ]);
    expect(byOrder["order-1"]![0]!.balanceDue).toBe(0);
  });

  it("a PAID sibling is excluded entirely (not PAYABLE) even though it's non-void", () => {
    const byOrder = groupPayableInvoicesByOrder([
      row({ id: "i1", status: "SENT", total: 50 }),
      row({ id: "i2", status: "PAID", total: 30 }),
    ]);
    expect(byOrder["order-1"]!.map((i) => i.id)).toEqual(["i1"]);
  });

  it("a VOID sibling never reaches this function at all (excluded by the query's own where)", () => {
    // groupPayableInvoicesByOrder trusts its input has no VOID rows — this
    // documents that payableInvoiceFindManyArgs is what actually excludes it.
    const byOrder = groupPayableInvoicesByOrder([row({ id: "i1", status: "SENT" })]);
    expect(byOrder["order-1"]).toHaveLength(1);
  });

  it("multiple PAYABLE siblings (a regulated split) each contribute their own balanceDue", () => {
    const byOrder = groupPayableInvoicesByOrder([
      row({ id: "base", status: "SENT", total: 60 }),
      row({ id: "base-R1", status: "SENT", total: 40, payments: [{ amount: 10, status: "PAID" }] }),
    ]);
    expect(byOrder["order-1"]).toEqual([
      { id: "base", status: "SENT", total: 60, balanceDue: 60, isDepositMirror: false },
      { id: "base-R1", status: "SENT", total: 40, balanceDue: 30, isDepositMirror: false },
    ]);
  });

  it("never returns raw payments rows on the mapped shape", () => {
    const byOrder = groupPayableInvoicesByOrder([
      row({ payments: [{ amount: 40, status: "PAID" }] }),
    ]);
    expect(JSON.stringify(byOrder)).not.toContain("payments");
  });

  it("groups independently across multiple orders", () => {
    const byOrder = groupPayableInvoicesByOrder([
      row({ id: "i1", orderId: "o1", total: 10 }),
      row({ id: "i2", orderId: "o2", total: 20 }),
    ]);
    expect(byOrder["o1"]!.map((i) => i.id)).toEqual(["i1"]);
    expect(byOrder["o2"]!.map((i) => i.id)).toEqual(["i2"]);
  });

  it("skips a row with no orderId rather than crashing or grouping it under 'null'", () => {
    const byOrder = groupPayableInvoicesByOrder([row({ orderId: null })]);
    expect(Object.keys(byOrder)).toHaveLength(0);
  });

  describe("isDepositMirror (SA-102's WP-D1 shape, mirrors reconcileOrderDraftInvoice exactly)", () => {
    it("true: the order's SOLE non-void invoice, no deliveryBatchId, a deposit, a mirror-eligible status", () => {
      const byOrder = groupPayableInvoicesByOrder([
        row({ status: "SENT", depositPercent: 25, deliveryBatchId: null, total: 100 }),
      ]);
      expect(byOrder["order-1"]![0]!.isDepositMirror).toBe(true);
    });

    it("false: a plain operator-issued SENT invoice with no deposit is never a mirror", () => {
      const byOrder = groupPayableInvoicesByOrder([
        row({ status: "SENT", depositPercent: null, total: 100 }),
      ]);
      expect(byOrder["order-1"]![0]!.isDepositMirror).toBe(false);
    });

    it("false: a deposit invoice tagged to a deliveryBatchId is never a mirror (that's a per-batch delivery invoice, not the order-tracking one)", () => {
      const byOrder = groupPayableInvoicesByOrder([
        row({ status: "SENT", depositPercent: 25, deliveryBatchId: "batch-1" }),
      ]);
      expect(byOrder["order-1"]![0]!.isDepositMirror).toBe(false);
    });

    it("false: a DRAFT deposit invoice is never a mirror — only SENT/VIEWED/PARTIAL/OVERDUE are mirror-eligible statuses", () => {
      const byOrder = groupPayableInvoicesByOrder([
        row({ status: "DRAFT", depositPercent: 25, deliveryBatchId: null }),
      ]);
      expect(byOrder["order-1"]![0]!.isDepositMirror).toBe(false);
    });

    it("false when there are TWO non-void invoices even if one carries a deposit — never a mirror once it's not sole", () => {
      const byOrder = groupPayableInvoicesByOrder([
        row({ id: "i1", status: "SENT", depositPercent: 25, deliveryBatchId: null }),
        row({ id: "i2", status: "PAID", total: 10 }),
      ]);
      expect(byOrder["order-1"]!.find((i) => i.id === "i1")!.isDepositMirror).toBe(false);
    });

    it("PARTIAL and OVERDUE are mirror-eligible statuses too, same as SENT", () => {
      for (const status of ["PARTIAL", "OVERDUE"]) {
        const byOrder = groupPayableInvoicesByOrder([
          row({ status, depositPercent: 25, deliveryBatchId: null }),
        ]);
        expect(byOrder["order-1"]![0]!.isDepositMirror).toBe(true);
      }
    });

    it("a VIEWED deposit mirror is mirror-eligible per the status check, but VIEWED isn't in PAYABLE at all — so it never surfaces in payableInvoices for the driver to see, mirror or not", () => {
      const byOrder = groupPayableInvoicesByOrder([
        row({ status: "VIEWED", depositPercent: 25, deliveryBatchId: null }),
      ]);
      expect(byOrder["order-1"] ?? []).toEqual([]);
    });
  });
});

describe("attachPayableInvoices", () => {
  it("attaches each order's payableInvoices from the byOrder map, defaulting to [] when absent", () => {
    const stops = [{ id: "stop-1", orders: [{ id: "o1" }, { id: "o2" }] }];
    const byOrder = {
      o1: [{ id: "i1", status: "SENT", total: 100, balanceDue: 60, isDepositMirror: false }],
    };
    const result = attachPayableInvoices(stops, byOrder);
    expect(result[0]!.orders[0]!.payableInvoices).toEqual(byOrder["o1"]);
    expect(result[0]!.orders[1]!.payableInvoices).toEqual([]);
  });

  it("tolerates a stop with no orders", () => {
    const stops: { id: string; orders?: { id: string }[] | null }[] = [{ id: "stop-1" }];
    const result = attachPayableInvoices(stops, {});
    expect(result[0]!.orders).toEqual([]);
  });
});

describe("withPayableInvoices", () => {
  it("runs ONE batched invoice.findMany over every order id across the given stops, then attaches", async () => {
    const findMany = jest.fn().mockResolvedValue([
      row({
        id: "i1",
        orderId: "o1",
        status: "SENT",
        total: 100,
        payments: [{ amount: 40, status: "PAID" }],
      }),
    ]);
    const stops = [
      { id: "stop-1", orders: [{ id: "o1" }] },
      { id: "stop-2", orders: [{ id: "o2" }] },
    ];
    const result = await withPayableInvoices({ invoice: { findMany } }, stops);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0]![0].where.orderId.in.sort()).toEqual(["o1", "o2"]);
    expect(result[0]!.orders[0]!.payableInvoices).toEqual([
      { id: "i1", status: "SENT", total: 100, balanceDue: 60, isDepositMirror: false },
    ]);
    expect(result[1]!.orders[0]!.payableInvoices).toEqual([]);
  });

  it("skips the query entirely when there are no orders at all — never a findMany with an empty IN", async () => {
    const findMany = jest.fn();
    const result = await withPayableInvoices({ invoice: { findMany } }, [
      { id: "stop-1", orders: [] },
    ]);
    expect(findMany).not.toHaveBeenCalled();
    expect(result[0]!.orders).toEqual([]);
  });
});

describe("withPayableInvoicesForRuns", () => {
  it("runs ONE batched invoice.findMany across EVERY run's stops on the page (never per-run), then re-chunks back onto each run in order", async () => {
    const findMany = jest.fn().mockResolvedValue([
      row({
        id: "i1",
        orderId: "o1",
        status: "SENT",
        total: 100,
        payments: [{ amount: 40, status: "PAID" }],
      }),
      row({
        id: "i2",
        orderId: "o2",
        status: "PARTIAL",
        total: 50,
        payments: [{ amount: 10, status: "PAID" }],
      }),
    ]);
    const runs = [
      { id: "run-1", stops: [{ id: "stop-1", orders: [{ id: "o1" }] }] },
      {
        id: "run-2",
        stops: [
          { id: "stop-2", orders: [{ id: "o2" }] },
          { id: "stop-3", orders: [] },
        ],
      },
    ];

    const result = await withPayableInvoicesForRuns({ invoice: { findMany } }, runs);

    expect(findMany).toHaveBeenCalledTimes(1); // ONE call for the whole page, not one per run
    expect(findMany.mock.calls[0]![0].where.orderId.in.sort()).toEqual(["o1", "o2"]);
    expect(result[0]!.id).toBe("run-1");
    expect(result[0]!.stops).toHaveLength(1);
    expect(result[0]!.stops[0]!.orders[0]!.payableInvoices).toEqual([
      { id: "i1", status: "SENT", total: 100, balanceDue: 60, isDepositMirror: false },
    ]);
    expect(result[1]!.id).toBe("run-2");
    expect(result[1]!.stops).toHaveLength(2); // stop-2 and stop-3 both preserved, in order
    expect(result[1]!.stops[0]!.orders[0]!.payableInvoices).toEqual([
      { id: "i2", status: "PARTIAL", total: 50, balanceDue: 40, isDepositMirror: false },
    ]);
    expect(result[1]!.stops[1]!.orders).toEqual([]);
  });

  it("tolerates an empty page of runs", async () => {
    const findMany = jest.fn();
    const result = await withPayableInvoicesForRuns({ invoice: { findMany } }, []);
    expect(findMany).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});
