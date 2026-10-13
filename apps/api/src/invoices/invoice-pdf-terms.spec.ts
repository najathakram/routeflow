import { readFileSync } from "fs";
import { join } from "path";
import { pdfTermsView } from "./invoice-pdf-terms";

/**
 * Row 401: the invoice PDF of a counter sale paid at the till prints no Due Date, no Terms and no "Terms & Conditions"
 * that is only the payment terms (the CQ-26 rule the invoice page follows). The template is mocked in jest, so the
 * decision lives in this pure helper and a static pin keeps the template and the service select wired to it.
 */
const at = new Date("2026-10-07T15:15:00.000Z");
const base = {
  status: "PAID",
  createdAt: at,
  order: { counterSale: true },
  payments: [{ createdAt: new Date(at.getTime() + 2000) }],
  paymentTermsLabel: "Net 30",
  terms: "Net 30",
};

describe("pdfTermsView (row 401)", () => {
  it("a paid-at-sale counter invoice hides the due date, the terms and a T&C that is only the terms", () => {
    expect(pdfTermsView(base)).toEqual({ showDueAndTerms: false, termsAndConditions: null });
  });

  it("a real long-form T&C text stays on a paid-at-sale invoice", () => {
    expect(pdfTermsView({ ...base, terms: "All sales final." })).toEqual({
      showDueAndTerms: false,
      termsAndConditions: "All sales final.",
    });
  });

  it("every other invoice keeps the due date, the terms and the T&C text", () => {
    for (const over of [
      { status: "SENT" },
      { order: { counterSale: false } },
      { order: null },
      { payments: [{ createdAt: new Date("2026-10-20T10:00:00.000Z") }] },
      { payments: [] },
    ]) {
      expect(pdfTermsView({ ...base, ...over })).toEqual({
        showDueAndTerms: true,
        termsAndConditions: "Net 30",
      });
    }
  });
});

describe("row 401 wiring", () => {
  const read = (f: string) => readFileSync(join(__dirname, f), "utf8");

  it("the template prints its due date, terms and T&C through pdfTermsView", () => {
    const src = read("invoice-pdf-template.tsx");
    expect(src).toContain("pdfTermsView(invoice)");
    expect(src).toMatch(/showDueAndTerms[\s\S]{0,40}invoice\.dueDate/);
    expect(src).toMatch(/termsAndConditions \?/);
    expect(src).not.toContain("{invoice.terms ?");
    // the deposit schedule's "Remainder due <date>" is a due date too: gated by the same rule
    expect(src).toMatch(/const hasDeposit =\s*terms\.showDueAndTerms &&/);
  });

  it("the PDF service selects what the predicate reads (the order's counterSale)", () => {
    expect(read("invoice-pdf.service.ts")).toMatch(/order: \{ select: \{[^}]*counterSale: true/);
  });
});
