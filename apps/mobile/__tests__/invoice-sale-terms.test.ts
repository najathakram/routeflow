import { readFileSync } from "fs";
import { join } from "path";
import { invoiceShowsTerms } from "../lib/invoice-sale-terms";

/**
 * Row 401: a counter sale paid at the till shows no due date and no payment terms on mobile (the CQ-26 rule the web
 * invoice page follows). The server answers with `paidAtSale` (isPaidAtSale); a staff payload from an older server
 * still carries what the shared rule reads. Jest here is pure-logic only, so the screens are source-pinned below.
 */
const at = "2026-10-07T15:15:00.000Z";
const till = {
  status: "PAID",
  createdAt: at,
  order: { counterSale: true },
  payments: [{ createdAt: "2026-10-07T15:15:02.000Z" }],
};

describe("invoiceShowsTerms", () => {
  it("the server's paidAtSale flag decides (buyer payloads carry no order or payment instants)", () => {
    expect(invoiceShowsTerms({ paidAtSale: true })).toBe(false);
    expect(invoiceShowsTerms({ paidAtSale: false })).toBe(true);
  });

  it("without the flag, the shared rule reads the payload (older server)", () => {
    expect(invoiceShowsTerms(till)).toBe(false);
    expect(invoiceShowsTerms({ ...till, status: "SENT" })).toBe(true);
    expect(
      invoiceShowsTerms({ ...till, payments: [{ createdAt: "2026-10-20T10:00:00.000Z" }] }),
    ).toBe(true);
  });

  it("an unclear or empty invoice keeps showing its terms", () => {
    expect(invoiceShowsTerms({})).toBe(true);
    expect(invoiceShowsTerms(null)).toBe(true);
    expect(invoiceShowsTerms(undefined)).toBe(true);
  });
});

describe("invoice screens read the rule (row 401)", () => {
  const read = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8");
  const operator = read("app", "(operator)", "(tabs)", "invoices", "[id].tsx");
  const customer = read("app", "(customer)", "invoices", "[id].tsx");

  it("the operator invoice hides the due-date row and the terms line when paid at sale", () => {
    expect(operator).toContain("invoiceShowsTerms(invoice)");
    // the due-date editor is never lost: the row stays, with a muted label instead of the printed date
    expect(operator).toMatch(/<Pressable\s+style=\{styles\.dueRow\}/);
    expect(operator).toMatch(/!showTerms\s*\? "Edit due date"/);
    expect(operator).toMatch(/showTerms && paymentTermsLabel/);
  });

  it("the customer invoice hides its due line and terms line when paid at sale", () => {
    expect(customer).toContain("invoiceShowsTerms(invoice)");
    expect(customer).toMatch(/showTerms && invoice\.dueDate/);
    expect(customer).toMatch(/showTerms && paymentTermsLabel/);
  });
});
