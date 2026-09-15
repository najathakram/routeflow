import {
  ADVANCE_METHOD,
  CASH_METHOD_FILTER,
  CONFIRMED_PAYMENT,
  CREDIT_NOTE_METHOD,
  splitConfirmed,
  sumConfirmed,
} from "./payment-predicates";

describe("splitConfirmed", () => {
  it("REG-B421 excludes a CREDIT_NOTE-method PAID row from cash, includes it in creditApplied", () => {
    const payments = [
      { amount: 870, status: "PAID", method: "CASH" },
      { amount: 638, status: "PAID", method: CREDIT_NOTE_METHOD },
    ];

    const result = splitConfirmed(payments);

    expect(result.cash).toBe(870);
    expect(result.creditApplied).toBe(638);
    expect(result.advanceApplied).toBe(0);
  });

  it("REG-B421 buckets an ADVANCE-method PAID row separately from cash and credit", () => {
    const payments = [
      { amount: 100, status: "PAID", method: "CHECK" },
      { amount: 50, status: "PAID", method: ADVANCE_METHOD },
    ];

    const result = splitConfirmed(payments);

    expect(result.cash).toBe(100);
    expect(result.creditApplied).toBe(0);
    expect(result.advanceApplied).toBe(50);
  });

  it("ignores DRAFT and VOID rows the same way sumConfirmed does", () => {
    const payments = [
      { amount: 25, status: "DRAFT", method: "CASH" },
      { amount: 40, status: "VOID", method: CREDIT_NOTE_METHOD },
      { amount: 10, status: "PAID", method: "CASH" },
    ];

    expect(splitConfirmed(payments)).toEqual({ cash: 10, creditApplied: 0, advanceApplied: 0 });
  });

  it("treats every non-CREDIT_NOTE/ADVANCE method as cash (CHECK/ACH/CREDIT_CARD/ZELLE/OTHER)", () => {
    const payments = ["CHECK", "ACH", "CREDIT_CARD", "ZELLE", "OTHER"].map((method) => ({
      amount: 1,
      status: "PAID",
      method,
    }));

    expect(splitConfirmed(payments).cash).toBe(5);
  });

  it("returns all zeros for null/undefined/empty, matching sumConfirmed's tolerance", () => {
    expect(splitConfirmed(null)).toEqual({ cash: 0, creditApplied: 0, advanceApplied: 0 });
    expect(splitConfirmed(undefined)).toEqual({ cash: 0, creditApplied: 0, advanceApplied: 0 });
    expect(splitConfirmed([])).toEqual({ cash: 0, creditApplied: 0, advanceApplied: 0 });
  });

  it("REG-B421: cash + creditApplied + advanceApplied always equals sumConfirmed over the same array", () => {
    const payments = [
      { amount: 870, status: "PAID", method: "CASH" },
      { amount: 638, status: "PAID", method: CREDIT_NOTE_METHOD },
      { amount: 50, status: "PAID", method: ADVANCE_METHOD },
      { amount: 999, status: "DRAFT", method: "CASH" },
      { amount: 999, status: "VOID", method: "CASH" },
    ];

    const { cash, creditApplied, advanceApplied } = splitConfirmed(payments);

    expect(cash + creditApplied + advanceApplied).toBe(sumConfirmed(payments));
    expect(sumConfirmed(payments)).toBe(1558);
  });
});

describe("CASH_METHOD_FILTER", () => {
  it("excludes exactly CREDIT_NOTE and ADVANCE, nothing else", () => {
    expect(CASH_METHOD_FILTER).toEqual({ notIn: [CREDIT_NOTE_METHOD, ADVANCE_METHOD] });
  });
});

describe("CONFIRMED_PAYMENT (unchanged by B421)", () => {
  it("still matches only PAID", () => {
    expect(CONFIRMED_PAYMENT).toEqual({ status: "PAID" });
  });
});
