import { buildReceiptModel } from "./receipt-model";
import { renderOrderReceipt } from "./render-order-receipt";
import { BRANDING, INVOICE, orderFixture, paymentsFixture } from "./receipt.fixtures";

/**
 * CQ-03: a regulated levy (deposit, excise) prints as its OWN named charge on the receipt: never inside Tax, never an
 * unexplained "Adjustments". The levy comes from the invoice's own billed lines (an exempt customer's are zero).
 */
const ZONE = "America/New_York";
// the fixture sale is 26.50 net + 2.12 tax = 28.62; the same sale with a 2.80 CRV deposit on a line
const withDeposit = {
  ...INVOICE,
  items: [
    ...(INVOICE.items ?? []),
    {
      taxRate: 0,
      categoryTaxAmount: "2.80",
      trackedCategoryId: "cat-crv",
      trackedCategory: { id: "cat-crv", name: "CRV", taxType: "DEPOSIT_PER_CONTAINER" },
    },
  ],
};
const order = orderFixture({ total: 31.42 });

describe("receipt charges (CQ-03)", () => {
  it("the deposit is a named charge, Tax is only the sales tax, and nothing is left for Adjustments", () => {
    const m = buildReceiptModel(order, [withDeposit], paymentsFixture(), BRANDING, ZONE);
    expect(m.tax).toBe(2.12);
    expect(m.charges).toEqual([{ key: "cat-crv", label: "CRV deposit", amount: 2.8 }]);
    expect(m.adjustments).toBe(0);
  });

  it("the print and the email render the charge row and no Adjustments row", () => {
    const out = renderOrderReceipt(order, [withDeposit], paymentsFixture(), BRANDING, ZONE);
    const text = JSON.stringify(out);
    expect(text).toContain("CRV deposit");
    expect(text).not.toContain("Adjustments");
  });

  it("an exempt customer's older order (stored tax the total never carried) prints no Tax and no reversal", () => {
    // total equals the net subtotal: the 2.12 stored tax was never charged
    const exempt = orderFixture({ total: 26.5 });
    const m = buildReceiptModel(exempt, [INVOICE], paymentsFixture(), BRANDING, ZONE);
    expect(m.tax).toBe(0);
    expect(m.adjustments).toBe(0);
    expect(m.charges).toEqual([]);
  });

  it("a sale with no regulated line has no charges", () => {
    const m = buildReceiptModel(orderFixture(), [INVOICE], paymentsFixture(), BRANDING, ZONE);
    expect(m.charges).toEqual([]);
  });
});
