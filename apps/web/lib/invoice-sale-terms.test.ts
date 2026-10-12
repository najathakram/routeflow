import { isPaidAtSale } from "./invoice-sale-terms";

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
