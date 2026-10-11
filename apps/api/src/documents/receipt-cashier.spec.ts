import { buildReceiptModel } from "./receipt-model";
import { renderOrderReceipt } from "./render-order-receipt";
import { BRANDING, INVOICE, orderFixture, paymentsFixture } from "./receipt.fixtures";

/** Row 317: the emailed receipt names the cashier like the reprint does. Placeholders only (acme). */
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

  it("the email prints 'Cashier: <name>' in the html and the plain text, escaped; no line without one", () => {
    const r = renderOrderReceipt(
      withCashier("jane <b>"),
      [INVOICE],
      paymentsFixture(),
      BRANDING,
      ZONE,
    );
    expect(r.html).toContain("Cashier: jane &lt;b&gt;");
    expect(r.html).not.toContain("jane <b>");
    expect(r.text).toContain("Cashier: jane <b>");
    const none = renderOrderReceipt(
      withCashier(null),
      [INVOICE],
      paymentsFixture(),
      BRANDING,
      ZONE,
    );
    expect(none.html).not.toContain("Cashier:");
    expect(none.text).not.toContain("Cashier:");
  });
});
