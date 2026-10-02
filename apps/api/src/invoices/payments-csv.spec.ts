import { buildPaymentsCsv, PAYMENTS_CSV_HEADER } from "./payments-csv";

describe("buildPaymentsCsv (B953 — formula-injection guard on user-typed text)", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    paymentNumber: "PAY-0003",
    paidAt: new Date("2026-07-03T00:00:00.000Z"),
    settledAt: null,
    method: "CHECK",
    reference: "ref-1",
    bankCharges: null,
    amount: 100,
    status: "PAID",
    invoice: { invoiceNumber: "INV-0003", customer: { businessName: "Acme" } },
    ...over,
  });

  it("keeps the header and the Bank Date column right after Date", () => {
    const [header, first] = buildPaymentsCsv([row()]).split("\n");
    expect(header).toBe(PAYMENTS_CSV_HEADER);
    expect(first.split(",").slice(0, 3)).toEqual(["PAY-0003", "2026-07-03", ""]);
  });

  it("guards formula-leading text but never a negative amount", () => {
    const line = buildPaymentsCsv([
      row({
        reference: '=HYPERLINK("http://evil.example","x")',
        bankCharges: -1,
        amount: -12.5,
        status: "REFUNDED",
        invoice: { invoiceNumber: "INV-0003", customer: { businessName: "@Acme" } },
      }),
    ]).split("\n")[1];

    expect(line).toContain("'@Acme");
    expect(line).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
    // Bank Charges and Amount: plain decimals, never prefixed.
    expect(line).toContain(",-1.00,-12.50,REFUNDED");
  });
});
