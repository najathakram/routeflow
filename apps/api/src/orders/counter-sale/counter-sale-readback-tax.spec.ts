import { buildCounterSaleResponse } from "./counter-sale-readback";

/**
 * SA-762r: the counter-sale response (POST and by-key) carries the order's tax and the sale's stored rate, so the live
 * receipt splits Tax from Adjustments like the reprint and the emailed receipt. The rate is pricing's storedTaxRatePercent
 * (one home); the receipt names it only through explainedTaxRatePercent.
 */
const inv = (items: Array<{ taxRate: string }>, over: Record<string, unknown> = {}) => ({
  id: "inv-1",
  invoiceNumber: "INV-1",
  total: "28.62",
  subtotal: "26.50",
  taxAmount: "2.12",
  items,
  payments: [{ id: "p1", amount: "28.62", method: "CASH", status: "PAID" }],
  ...over,
});
const build = (tax: unknown, invoices: ReturnType<typeof inv>[], configured: number | null = 8) =>
  buildCounterSaleResponse({
    order: { id: "o1", orderNumber: "ORD-1", counterCashTendered: null, tax },
    invoices,
    replayed: false,
    configuredTaxPercent: configured,
  });

describe("counter-sale response: tax and taxRatePercent (SA-762r)", () => {
  it("serves Order.tax to the cent and the stored line rate in percent", () => {
    const r = build("2.12", [inv([{ taxRate: "0.0800" }, { taxRate: "0.0800" }])]);
    expect(r.tax).toBe(2.12);
    expect(r.taxRatePercent).toBe(8);
  });

  it("a legacy invoice whose lines all store 0 serves no rate (it is never inferred from the header tax)", () => {
    const r = build("2.12", [inv([{ taxRate: "0" }, { taxRate: "0" }])]);
    expect(r.taxRatePercent).toBeNull();
  });

  it("RULING: a derived stored rate (0.0827) against a configured 8% is not served; with no configured rate nothing is", () => {
    expect(build("2.12", [inv([{ taxRate: "0.0827" }])]).taxRatePercent).toBeNull();
    expect(build("2.12", [inv([{ taxRate: "0.0800" }])], null).taxRatePercent).toBeNull();
  });

  it("mixed line rates serve a null candidate; no rate lines serve null", () => {
    expect(
      build("2.12", [inv([{ taxRate: "0.08" }, { taxRate: "0.06" }])]).taxRatePercent,
    ).toBeNull();
    expect(build("2.12", [inv([])]).taxRatePercent).toBeNull();
  });

  it("an order read without a tax figure omits both (an older read-back; the receipt then prints no Tax row)", () => {
    const r = build(undefined, [inv([{ taxRate: "0.08" }])]);
    expect(r).not.toHaveProperty("tax");
    expect(r).not.toHaveProperty("taxRatePercent");
  });

  it("a zero tax is served as 0, not omitted", () => {
    expect(build("0.00", [inv([{ taxRate: "0" }], { taxAmount: "0.00" })]).tax).toBe(0);
  });
});
