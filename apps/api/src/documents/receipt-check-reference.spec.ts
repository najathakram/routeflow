import { buildReceiptModel } from "./receipt-model";
import { renderOrderReceipt } from "./render-order-receipt";
import { BRANDING, INVOICE, orderFixture } from "./receipt.fixtures";

/** W-713: the emailed receipt reads the check number the reprint reads ("Check #1042"). Placeholders only (acme). */
const ZONE = "America/New_York";
const payments = (reference: string | null) => [
  { invoiceId: "inv-1", method: "CHECK", amount: "28.62", status: "PAID", reference },
];

describe("receipt: check number", () => {
  it("an emailed check sale reads Check #1042", () => {
    const m = buildReceiptModel(orderFixture(), [INVOICE], payments(" 1042 "), BRANDING, ZONE);
    expect(m.methodLabel).toBe("Check #1042 $28.62");
    const r = renderOrderReceipt(orderFixture(), [INVOICE], payments("1042"), BRANDING, ZONE);
    expect(r.text).toContain("Check #1042");
  });

  it("a check with no number keeps reading Check", () => {
    const m = buildReceiptModel(orderFixture(), [INVOICE], payments(null), BRANDING, ZONE);
    expect(m.methodLabel).toBe("Check $28.62");
  });
});
