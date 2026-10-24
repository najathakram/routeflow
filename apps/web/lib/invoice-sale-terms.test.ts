import { isPaidAtSale, termsAndConditionsToShow } from "./invoice-sale-terms";

const base = {
  status: "PAID",
  createdAt: "2026-10-07T15:15:00.000Z",
  order: { counterSale: true },
  payments: [{ createdAt: "2026-10-07T15:15:02.000Z" }],
};

describe("isPaidAtSale (CQ-26)", () => {
  it("a counter sale paid in the same request has no terms or due date to show", () => {
    expect(isPaidAtSale(base)).toBe(true);
  });
  it("a counter sale on account (not PAID) keeps its terms", () => {
    expect(isPaidAtSale({ ...base, status: "SENT" })).toBe(false);
  });
  it("a counter sale paid days later keeps its terms", () => {
    expect(isPaidAtSale({ ...base, payments: [{ createdAt: "2026-10-20T10:00:00.000Z" }] })).toBe(
      false,
    );
  });
  it("an ordinary order's invoice keeps its terms", () => {
    expect(isPaidAtSale({ ...base, order: { counterSale: false } })).toBe(false);
    expect(isPaidAtSale({ ...base, order: null })).toBe(false);
  });
  it("an unclear payload (no payments, no timestamps) is never treated as paid at sale", () => {
    expect(isPaidAtSale({ ...base, payments: [] })).toBe(false);
    expect(isPaidAtSale({ ...base, payments: undefined })).toBe(false);
    expect(isPaidAtSale({ ...base, createdAt: undefined })).toBe(false);
    expect(isPaidAtSale({ ...base, payments: [{}] })).toBe(false);
    expect(isPaidAtSale(null)).toBe(false);
  });
});

describe("termsAndConditionsToShow (CQ-26 follow-up)", () => {
  const paid = { ...base, paymentTermsLabel: "Net 30" };
  it("a paid-at-sale invoice drops a T&C text that is only the payment terms", () => {
    expect(termsAndConditionsToShow({ ...paid, terms: "Net 30" })).toBeNull();
    expect(
      termsAndConditionsToShow({ ...paid, terms: " Due on Receipt ", paymentTermsLabel: null }),
    ).toBeNull();
  });
  it("a real long-form T&C text stays on a paid-at-sale invoice", () => {
    expect(termsAndConditionsToShow({ ...paid, terms: "All sales final." })).toBe(
      "All sales final.",
    );
  });
  it("any other invoice keeps its text, payment terms included", () => {
    expect(termsAndConditionsToShow({ ...paid, status: "SENT", terms: "Net 30" })).toBe("Net 30");
    expect(
      termsAndConditionsToShow({ ...paid, order: { counterSale: false }, terms: "Net 30" }),
    ).toBe("Net 30");
  });
  it("no text is no row", () => {
    expect(termsAndConditionsToShow({ ...paid, terms: "  " })).toBeNull();
    expect(termsAndConditionsToShow(null)).toBeNull();
  });
});
