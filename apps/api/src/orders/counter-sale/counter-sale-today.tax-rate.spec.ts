import { pageQuery, toTodaysSaleRow, type TodayOrderRecord } from "./counter-sale-today";

/** SA-764 Rule 2: the Today's-sales row carries the stored cash tendered and the sale's single tax rate. */
const rec = (over: Partial<TodayOrderRecord> = {}, rates: string[] = ["0.0825", "0.0825"]) =>
  ({
    id: "o1",
    orderNumber: "ORD-1",
    status: "DELIVERED",
    total: "41.27",
    createdAt: new Date("2026-10-09T15:00:00Z"),
    customerId: "c1",
    customer: { businessName: "Acme", isWalkIn: false },
    counterCashTendered: null,
    invoices: [
      {
        id: "i1",
        invoiceNumber: "N-1",
        status: "SENT",
        payments: [],
        items: rates.map((taxRate) => ({ taxRate })),
      },
    ],
    returns: [],
    ...over,
  }) as TodayOrderRecord;

describe("Today's sales row: cashTendered and taxRatePercent (SA-764)", () => {
  it("(d) all lines at 0.0825 -> 8.25, and the stored tendered is returned as a number", () => {
    const row = toTodaysSaleRow(rec({ counterCashTendered: "50.00" }), 8.25);
    expect(row.taxRatePercent).toBe(8.25);
    expect(row.cashTendered).toBe(50);
  });

  it("(d) a null column reads null", () => {
    expect(toTodaysSaleRow(rec({})).cashTendered).toBeNull();
  });

  it("the rate is pricing's storedTaxRatePercent over the live invoices' lines, corroborated by the configured rate", () => {
    expect(toTodaysSaleRow(rec({}, ["0.0825", "0.0825"]), 8.25).taxRatePercent).toBe(8.25);
    expect(toTodaysSaleRow(rec({}, ["0.0825", "0"]), 8.25).taxRatePercent).toBe(8.25);
    expect(toTodaysSaleRow(rec({}, ["0.0825", "0.0600"]), 8.25).taxRatePercent).toBeNull();
    expect(toTodaysSaleRow(rec({}, []), 8.25).taxRatePercent).toBeNull();
  });

  it("RULING: a derived stored rate (0.0827 on a sale taxed at the configured 8.25%) is never named", () => {
    expect(toTodaysSaleRow(rec({}, ["0.0827"]), 8.25).taxRatePercent).toBeNull();
    expect(toTodaysSaleRow(rec({}, ["0.0825"]), null).taxRatePercent).toBeNull();
    expect(toTodaysSaleRow(rec({}, ["0.0825"])).taxRatePercent).toBeNull();
  });

  it("a legacy invoice whose lines ALL store 0 names nothing: no rate is inferred from the header tax", () => {
    const o = rec({}, ["0", "0"]);
    expect(toTodaysSaleRow(o, 8.25).taxRatePercent).toBeNull();
  });

  it("only LIVE invoices' lines count (a voided sibling's rate is ignored)", () => {
    const o = rec();
    o.invoices.push({
      id: "i2",
      invoiceNumber: "N-2",
      status: "VOID",
      payments: [],
      items: [{ taxRate: "0.0600" }],
    });
    expect(toTodaysSaleRow(o, 8.25).taxRatePercent).toBe(8.25);
  });

  it("change is the stored tendered less the sale's own CASH rows (storedChange); null with none", () => {
    const o = rec({ counterCashTendered: "50.00" });
    o.invoices[0].payments = [
      { method: "CASH", amount: "41.27", status: "PAID" },
      { method: "CREDIT_NOTE", amount: "5.00", status: "PAID" },
    ];
    // the credit note is a payment too: 41.27 + 5.00 > 41.27 total, so nothing is owed and change is served
    expect(toTodaysSaleRow(o).change).toBe(8.73);
    expect(toTodaysSaleRow(rec({ counterCashTendered: "50.00" })).change).toBeNull();
    expect(toTodaysSaleRow(rec()).change).toBeNull();
  });

  it("(N3) a partly paid cash sale serves no change", () => {
    const o = rec({ counterCashTendered: "50.00" });
    o.invoices[0].payments = [{ method: "CASH", amount: "20.00", status: "PAID" }];
    const row = toTodaysSaleRow(o);
    expect(row.balanceDue).toBe(21.27);
    expect(row.change).toBeNull();
  });

  it("(N3) a card sale with a stale stored tendered serves no change", () => {
    const o = rec({ counterCashTendered: "50.00" });
    o.invoices[0].payments = [{ method: "CREDIT_CARD", amount: "41.27", status: "PAID" }];
    expect(toTodaysSaleRow(o).change).toBeNull();
  });

  it("(N3) a fully paid cash sale serves the number", () => {
    const o = rec({ counterCashTendered: "50.00" });
    o.invoices[0].payments = [{ method: "CASH", amount: "41.27", status: "PAID" }];
    expect(toTodaysSaleRow(o).change).toBe(8.73);
  });

  it("(N2) a later CASH payment past the tendered never serves a negative change", () => {
    const o = rec({ counterCashTendered: "50.00" });
    o.invoices[0].payments = [
      { method: "CASH", amount: "41.27", status: "PAID" },
      { method: "CASH", amount: "20.00", status: "PAID" },
    ];
    expect(toTodaysSaleRow(o).change).toBeNull();
  });

  it("the page query reads both in the ONE existing query: the column, each invoice's line rates", () => {
    const q = pageQuery("t1", { start: new Date(0), end: new Date(1) }, 1, 20);
    expect(q.select.counterCashTendered).toBe(true);
    // CQ-03: the rate AND the billed levy with its category name (the receipt names it as its own charge)
    expect(q.select.invoices.select.items).toEqual({
      select: {
        description: true, // R7b 2.1: the row's item names
        qty: true,
        boxes: true, // N4: the receipt's own quantity text
        pieces: true,
        unitLabel: true,
        taxRate: true,
        categoryTaxAmount: true,
        trackedCategoryId: true,
        categoryTaxType: true,
        trackedCategory: { select: { id: true, name: true, taxType: true } },
      },
    });
  });
});
