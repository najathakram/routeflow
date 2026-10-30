import { validatePayment } from "./counter-sale";

/**
 * SA-933 / W-822(a) S4: an IDENTIFIED customer can pay part now by cash and the rest goes on account; a walk-in still pays the
 * full total. The server already allows it (planCounterPayment: below the balance is a partial payment; only a walk-in is held
 * to the total, assertWalkInTenderCoversTotal).
 */
describe("validatePayment: a short cash tender (S4)", () => {
  const base = { method: "CASH" as const, total: 12.5, reference: "" };

  it("allows an identified customer's short cash tender", () => {
    expect(validatePayment({ ...base, tendered: 5, isWalkIn: false })).toBeNull();
    expect(validatePayment({ ...base, tendered: 12.49, isWalkIn: false })).toBeNull();
  });

  it("still refuses a walk-in's short cash tender", () => {
    expect(validatePayment({ ...base, tendered: 5, isWalkIn: true })).toBe("TENDER_SHORT");
    expect(validatePayment({ ...base, tendered: 12.49, isWalkIn: true })).toBe("TENDER_SHORT");
  });

  it("an identified customer still needs SOMETHING tendered for cash (zero is not a part payment)", () => {
    expect(validatePayment({ ...base, tendered: 0, isWalkIn: false })).toBe("TENDER_SHORT");
    expect(validatePayment({ ...base, tendered: undefined, isWalkIn: false })).toBe("TENDER_SHORT");
    expect(validatePayment({ ...base, tendered: 0.004, isWalkIn: false })).toBe("TENDER_SHORT");
  });

  it("a full or over tender passes for both", () => {
    expect(validatePayment({ ...base, tendered: 12.5, isWalkIn: true })).toBeNull();
    expect(validatePayment({ ...base, tendered: 20, isWalkIn: false })).toBeNull();
  });
});

describe("validatePayment: a surface that has not opened part payment", () => {
  it("fullTenderOnly keeps an identified customer's short cash tender refused (the store-pickup dialog)", () => {
    expect(
      validatePayment({
        method: "CASH",
        total: 12.5,
        tendered: 5,
        isWalkIn: false,
        fullTenderOnly: true,
      }),
    ).toBe("TENDER_SHORT");
  });
});
