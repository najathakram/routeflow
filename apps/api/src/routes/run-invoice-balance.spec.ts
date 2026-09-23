import {
  RUN_PAYABLE_INVOICE_SELECT,
  withBalanceDue,
  withRunOrderBalances,
} from "./run-invoice-balance";

describe("withBalanceDue (B810 — SA-125)", () => {
  it("SENT 100 paid 40 -> balanceDue 60, not the full total", () => {
    const out = withBalanceDue([
      {
        id: "inv-1",
        status: "SENT",
        total: 100,
        payments: [{ amount: 40, status: "PAID" }],
      },
    ]);
    expect(out).toEqual([{ id: "inv-1", status: "SENT", balanceDue: 60 }]);
  });

  it("PARTIAL 100 paid 40 -> balanceDue 60 (same formula as SENT)", () => {
    const out = withBalanceDue([
      { id: "inv-2", status: "PARTIAL", total: 100, payments: [{ amount: 40, status: "PAID" }] },
    ]);
    expect(out[0]!.balanceDue).toBe(60);
  });

  it("DRAFT with no payments -> balanceDue equals total, byte-identical to today's number", () => {
    const out = withBalanceDue([{ id: "inv-3", status: "DRAFT", total: 50, payments: [] }]);
    expect(out[0]!.balanceDue).toBe(50);
  });

  it("uniform formula: a DRAFT with a confirmed payment (an applied advance) nets down too", () => {
    const out = withBalanceDue([
      { id: "inv-4", status: "DRAFT", total: 50, payments: [{ amount: 20, status: "PAID" }] },
    ]);
    expect(out[0]!.balanceDue).toBe(30);
  });

  it("only CONFIRMED payments count -- an unconfirmed/DRAFT payment row is ignored", () => {
    const out = withBalanceDue([
      {
        id: "inv-5",
        status: "SENT",
        total: 100,
        payments: [
          { amount: 40, status: "PAID" },
          { amount: 25, status: "DRAFT" },
        ],
      },
    ]);
    expect(out[0]!.balanceDue).toBe(60);
  });

  it("clamps at 0 -- an overpayment never reads negative", () => {
    const out = withBalanceDue([
      { id: "inv-6", status: "PARTIAL", total: 50, payments: [{ amount: 75, status: "PAID" }] },
    ]);
    expect(out[0]!.balanceDue).toBe(0);
  });

  it("never returns the raw payments rows", () => {
    const out = withBalanceDue([
      { id: "inv-7", status: "SENT", total: 100, payments: [{ amount: 10, status: "PAID" }] },
    ]);
    expect((out[0] as any).payments).toBeUndefined();
    expect((out[0] as any).total).toBeUndefined();
  });
});

describe("RUN_PAYABLE_INVOICE_SELECT (B810 — SA-125)", () => {
  it("filters to PAYABLE statuses (DRAFT/SENT/PARTIAL/OVERDUE), excluding PAID/VOID/WRITTEN_OFF", () => {
    expect(RUN_PAYABLE_INVOICE_SELECT.where.status.in).toEqual([
      "DRAFT",
      "SENT",
      "PARTIAL",
      "OVERDUE",
    ]);
  });

  it("carries NO deliveryBatchId gate -- a batch-tagged SENT invoice must still be counted", () => {
    expect(RUN_PAYABLE_INVOICE_SELECT.where).not.toHaveProperty("deliveryBatchId");
  });

  it("orders oldest-first, mirroring recordDeliveryPaymentInTx's own query exactly", () => {
    expect(RUN_PAYABLE_INVOICE_SELECT.orderBy).toEqual([
      { createdAt: "asc" },
      { invoiceNumber: "asc" },
    ]);
  });
});

describe("withRunOrderBalances (B810 — SA-125, the one mapper applied at all 4 call sites)", () => {
  it("maps every order's payableInvoices within a stops array", () => {
    const stops = [
      {
        id: "stop-1",
        orders: [
          {
            id: "ord-1",
            payableInvoices: [
              {
                id: "inv-1",
                status: "SENT",
                total: 100,
                payments: [{ amount: 40, status: "PAID" }],
              },
            ],
          },
        ],
      },
    ];
    const out = withRunOrderBalances(stops);
    expect(out[0]!.orders[0]!.payableInvoices).toEqual([
      { id: "inv-1", status: "SENT", balanceDue: 60 },
    ]);
  });

  it("never leaks the raw payments rows onto the serialized stop", () => {
    const stops = [
      {
        id: "stop-1",
        orders: [
          {
            id: "ord-1",
            payableInvoices: [
              {
                id: "inv-1",
                status: "SENT",
                total: 100,
                payments: [{ amount: 40, status: "PAID" }],
              },
            ],
          },
        ],
      },
    ];
    const out = withRunOrderBalances(stops);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('"payments"');
  });

  it("tolerates a stop with no orders, or an order with no payableInvoices", () => {
    expect(withRunOrderBalances([{ id: "stop-1", orders: [] }])[0]!.orders).toEqual([]);
    expect(
      withRunOrderBalances([{ id: "stop-1", orders: [{ id: "ord-1" }] }])[0]!.orders[0]!
        .payableInvoices,
    ).toEqual([]);
  });
});
