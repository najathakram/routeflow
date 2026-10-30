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

// SA-943: paidAt/settledAt are real instants (a past day is the tenant's local midnight, "today" is
// the moment itself), so the export must read them back as the TENANT's day, not the UTC slice.
describe("buildPaymentsCsv (SA-943 — Date and Bank Date are the tenant's day)", () => {
  const dates = (paidAt: string, settledAt: string | null, zone: string | null) =>
    buildPaymentsCsv(
      [
        {
          paymentNumber: "PAY-0009",
          paidAt: new Date(paidAt),
          settledAt: settledAt ? new Date(settledAt) : null,
          method: "CHECK",
          reference: null,
          bankCharges: null,
          amount: 10,
          status: "PAID",
          invoice: { invoiceNumber: "INV-0009", customer: { businessName: "Acme" } },
        },
      ],
      zone,
    )
      .split("\n")[1]
      .split(",")
      .slice(1, 3);

  it("an evening payment in Chicago is the 29th, not the UTC 30th", () => {
    // 20:00 CDT on 2026-10-29 is 01:00Z on the 30th.
    expect(dates("2026-10-30T01:00:00.000Z", null, "America/Chicago")).toEqual(["2026-10-29", ""]);
  });

  it("a backdated day east of UTC keeps its own day, not the day before", () => {
    // Sydney's 2026-10-01 local midnight is 14:00Z on 09-30.
    expect(dates("2026-09-30T14:00:00.000Z", null, "Australia/Sydney")).toEqual(["2026-10-01", ""]);
  });

  it("Bank Date reads the tenant day too", () => {
    expect(
      dates("2026-10-30T01:00:00.000Z", "2026-10-30T01:00:00.000Z", "America/Chicago"),
    ).toEqual(["2026-10-29", "2026-10-29"]);
  });

  it("a null zone keeps the UTC day (unchanged for callers that pass none)", () => {
    expect(dates("2026-10-29T00:00:00.000Z", "2026-10-29T00:00:00.000Z", null)).toEqual([
      "2026-10-29",
      "2026-10-29",
    ]);
  });
});
