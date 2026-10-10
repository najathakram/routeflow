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
    const row = toTodaysSaleRow(rec({ counterCashTendered: "50.00" }));
    expect(row.taxRatePercent).toBe(8.25);
    expect(row.cashTendered).toBe(50);
  });

  it("(d) a null column reads null, and a 4-dp rate rounds to 3 dp (0.0888 -> 8.88)", () => {
    const row = toTodaysSaleRow(rec({}, ["0.0888"]));
    expect(row.cashTendered).toBeNull();
    expect(row.taxRatePercent).toBe(8.88);
  });

  it("(e) mixed rates -> null", () => {
    expect(toTodaysSaleRow(rec({}, ["0.0825", "0.0600"])).taxRatePercent).toBeNull();
  });

  it("(e) zero-rate lines are ignored; only zero-rate or no lines -> null", () => {
    expect(toTodaysSaleRow(rec({}, ["0.0825", "0"])).taxRatePercent).toBe(8.25);
    expect(toTodaysSaleRow(rec({}, ["0", "0"])).taxRatePercent).toBeNull();
    expect(toTodaysSaleRow(rec({}, [])).taxRatePercent).toBeNull();
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
    expect(toTodaysSaleRow(o).taxRatePercent).toBe(8.25);
  });

  it("the page query reads both in the ONE existing query: the column and each invoice's line rates", () => {
    const q = pageQuery("t1", { start: new Date(0), end: new Date(1) }, 1, 20);
    expect(q.select.counterCashTendered).toBe(true);
    expect(q.select.invoices.select.items).toEqual({ select: { taxRate: true } });
  });
});
