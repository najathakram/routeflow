import { buildCustomersCsv, CUSTOMERS_CSV_HEADER } from "./customers-csv";

const customer = (over: Record<string, unknown> = {}) => ({
  businessName: "Acme, Inc.",
  contactName: null,
  email: "buyer@acme.example",
  phone: null,
  customerType: "RETAIL",
  status: null,
  receivables: 0,
  credits: 0,
  ...over,
});

describe("buildCustomersCsv (B953 — formula-injection guard on user-typed text)", () => {
  it("keeps the header and the newline-joined, BOM-free shape", () => {
    const csv = buildCustomersCsv([customer() as never]);
    expect(csv.split("\n")[0]).toBe(CUSTOMERS_CSV_HEADER);
    expect(csv.startsWith("﻿")).toBe(false);
  });

  it("prefixes user-typed text a spreadsheet would run as a formula", () => {
    const csv = buildCustomersCsv([
      customer({
        businessName: '=HYPERLINK("http://evil.example","x")',
        contactName: "@SUM(1+1)",
        email: "-cmd@example.com",
        phone: "+1 555 0100",
        customerType: "WHOLESALE",
        status: "ACTIVE",
      }) as never,
    ]);
    const row = csv.split("\n")[1];

    expect(row).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
    expect(row).toContain("'@SUM(1+1)");
    expect(row).toContain("'-cmd@example.com");
    // SA-629c: a numeric-only "+"-led phone cannot run as a formula, so it exports clean.
    expect(row).toContain("+1 555 0100");
    expect(row).not.toContain("'+1 555 0100");
  });

  it("leaves ordinary text and the money columns untouched (a negative credit is never prefixed)", () => {
    const row = buildCustomersCsv([customer({ credits: -12.5 }) as never]).split("\n")[1];

    expect(row.startsWith(`"Acme, Inc.",,buyer@acme.example,,RETAIL,,0.00,-12.50`)).toBe(true);
  });
});
