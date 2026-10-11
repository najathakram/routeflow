import { buildReceiptModel } from "./receipt-model";
import { renderOrderReceipt } from "./render-order-receipt";
import { BRANDING, INVOICE, orderFixture, paymentsFixture } from "./receipt.fixtures";

/** Row 317 / owner ruling (A): the receipt MODEL carries the cashier (staff on-screen view); the e-mailed copy never prints it. Placeholders only (acme). */
const ZONE = "America/New_York";
const withCashier = (username: string | null) => ({
  ...orderFixture(),
  soldBy: username === null ? null : { username },
});

describe("receipt: Cashier line", () => {
  it("the model carries the cashier's name from Order.soldBy", () => {
    const m = buildReceiptModel(withCashier("jane"), [INVOICE], paymentsFixture(), BRANDING, ZONE);
    expect(m.cashier).toBe("jane");
  });

  it("is null when the sale has no stored cashier (an old row), or the name is an email", () => {
    for (const soldBy of [null, "jane@acme.test"]) {
      const m = buildReceiptModel(
        withCashier(soldBy),
        [INVOICE],
        paymentsFixture(),
        BRANDING,
        ZONE,
      );
      expect(m.cashier).toBeNull();
    }
  });

  it("owner ruling (A): the emailed copy carries NO cashier text, even when soldBy is set and the name qualifies", () => {
    const r = renderOrderReceipt(withCashier("jane"), [INVOICE], paymentsFixture(), BRANDING, ZONE);
    expect(r.model.cashier).toBe("jane"); // the shared model still carries it for the staff on-screen view
    for (const out of [r.html, r.text]) {
      expect(out).not.toMatch(/cashier/i);
      expect(out).not.toContain("jane");
    }
  });
});
