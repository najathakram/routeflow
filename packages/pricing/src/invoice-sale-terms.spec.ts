import { isPaidAtSale, termsAndConditionsToShow } from "./invoice-sale-terms";

/**
 * Row 401: the one paid-at-sale rule every invoice surface reads (web detail, PDF, e-mail, mobile). The web wrapper's
 * own spec pins the JSON-string shape; this one pins the Prisma shape (Date instants) the API and PDF pass in.
 */
const at = new Date("2026-10-07T15:15:00.000Z");
const base = {
  status: "PAID",
  createdAt: at,
  order: { counterSale: true },
  payments: [{ createdAt: new Date(at.getTime() + 2000) }],
};

describe("isPaidAtSale with Date instants", () => {
  it("a counter sale whose payment row was written in the same request is paid at the sale", () => {
    expect(isPaidAtSale(base)).toBe(true);
  });
  it("a payment recorded days later, or any unclear instant, keeps the terms", () => {
    expect(
      isPaidAtSale({ ...base, payments: [{ createdAt: new Date("2026-10-20T10:00:00Z") }] }),
    ).toBe(false);
    expect(isPaidAtSale({ ...base, payments: [{ createdAt: new Date("nope") }] })).toBe(false);
    expect(isPaidAtSale({ ...base, createdAt: null })).toBe(false);
  });
  it("a VOID row (a duplicate recorded later, then voided) is not a payment; DRAFT rows still count", () => {
    const later = new Date("2026-10-09T10:00:00Z");
    expect(
      isPaidAtSale({ ...base, payments: [...base.payments, { createdAt: later, status: "VOID" }] }),
    ).toBe(true);
    expect(
      isPaidAtSale({
        ...base,
        payments: [...base.payments, { createdAt: later, status: "DRAFT" }],
      }),
    ).toBe(false);
    expect(isPaidAtSale({ ...base, payments: [{ createdAt: at, status: "VOID" }] })).toBe(false);
  });
  it("mixed strings and Dates agree", () => {
    expect(
      isPaidAtSale({
        ...base,
        createdAt: at.toISOString(),
        payments: [{ createdAt: new Date(at.getTime() + 1000) }],
      }),
    ).toBe(true);
  });
});

describe("termsAndConditionsToShow", () => {
  it("drops a T&C text that is only a payment-terms label on a paid-at-sale invoice, by label or by the closed list", () => {
    expect(
      termsAndConditionsToShow({ ...base, terms: "Net 15", paymentTermsLabel: "Net 30" }),
    ).toBeNull();
    expect(termsAndConditionsToShow({ ...base, terms: "Due on Receipt" })).toBeNull();
    expect(termsAndConditionsToShow({ ...base, terms: "All sales final." })).toBe(
      "All sales final.",
    );
    expect(termsAndConditionsToShow({ ...base, status: "SENT", terms: "Net 15" })).toBe("Net 15");
  });
});
