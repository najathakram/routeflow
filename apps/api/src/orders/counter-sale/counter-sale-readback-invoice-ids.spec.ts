import { buildCounterSaleResponse } from "./counter-sale-readback";

/**
 * SA-1026 B: a mixed regulated + unregulated counter sale makes sibling invoices (allocateOldestFirst), and the response's
 * total adds up all of them. `invoiceIds` is the same list, in issue order (`invoiceId` stays the first), so the done
 * screen's Print invoice prints every invoice the figures total, as the hand-over's response already does.
 */
const inv = (id: string, total: string) => ({
  id,
  invoiceNumber: `INV-${id}`,
  total,
  subtotal: total,
  taxAmount: "0",
  items: [{ taxRate: "0" }],
  payments: [{ id: `p-${id}`, amount: total, method: "CASH", status: "PAID" }],
});
const build = (invoices: ReturnType<typeof inv>[]) =>
  buildCounterSaleResponse({
    order: { id: "o1", orderNumber: "ORD-1", counterCashTendered: null, tax: "0" },
    invoices,
    replayed: false,
    configuredTaxPercent: null,
  });

describe("counter-sale response: invoiceIds (SA-1026 B)", () => {
  it("a sale of two sibling invoices names both, in issue order, and the total adds both", () => {
    const r = build([inv("a", "10.00"), inv("b", "5.50")]);
    expect(r.invoiceIds).toEqual(["a", "b"]);
    expect(r.invoiceId).toBe("a");
    expect(r.total).toBe(15.5);
  });

  it("a one-invoice sale names that one", () => {
    const r = build([inv("a", "10.00")]);
    expect(r.invoiceIds).toEqual(["a"]);
    expect(r.invoiceId).toBe("a");
  });
});
