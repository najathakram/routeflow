import {
  ADVANCE_METHOD,
  CASH_METHOD_FILTER,
  CONFIRMED_PAYMENT,
  CONFIRMED_STATUS,
  CREDIT_NOTE_METHOD,
  resolveConfirmedAmounts,
  splitConfirmed,
  sumConfirmed,
} from "./payment-confirmation";

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

describe("resolveConfirmedAmounts", () => {
  const payments = [
    { amount: 232, status: "PAID", method: "CASH" },
    { amount: 638, status: "PAID", method: CREDIT_NOTE_METHOD },
    { amount: 100, status: "PAID", method: ADVANCE_METHOD },
  ];

  it("prefers a caller's own totalPaid, defaulting missing creditApplied/advanceApplied to 0", () => {
    expect(resolveConfirmedAmounts({ totalPaid: 232 }, payments)).toEqual({
      cash: 232,
      creditApplied: 0,
      advanceApplied: 0,
    });
  });

  it("uses a caller's creditApplied/advanceApplied when given alongside totalPaid", () => {
    expect(
      resolveConfirmedAmounts(
        { totalPaid: 232, creditApplied: 638, advanceApplied: 100 },
        payments,
      ),
    ).toEqual({ cash: 232, creditApplied: 638, advanceApplied: 100 });
  });

  it("REG-B421 hardening: never mixes an old credit-inclusive totalPaid with a freshly split credit/advance -- falls back to splitConfirmed for ALL three only when totalPaid is absent", () => {
    // A caller stuck on the pre-B421 shape passes the OLD full-inclusive sum
    // (232 cash + 638 credit + 100 advance = 970) and nothing else. Deriving
    // creditApplied/advanceApplied from `payments` here would double-subtract
    // the 638 and 100 already folded into that 970. See lesson L-159.
    expect(resolveConfirmedAmounts({ totalPaid: 970 }, payments)).toEqual({
      cash: 970,
      creditApplied: 0,
      advanceApplied: 0,
    });
    // Only when totalPaid itself is absent do all three come from one split.
    expect(resolveConfirmedAmounts({}, payments)).toEqual(splitConfirmed(payments));
  });

  it("tolerates a null/undefined payments array when falling back", () => {
    expect(resolveConfirmedAmounts({}, null)).toEqual({
      cash: 0,
      creditApplied: 0,
      advanceApplied: 0,
    });
    expect(resolveConfirmedAmounts({}, undefined)).toEqual({
      cash: 0,
      creditApplied: 0,
      advanceApplied: 0,
    });
  });
});

describe("CASH_METHOD_FILTER", () => {
  it("excludes exactly CREDIT_NOTE and ADVANCE, nothing else", () => {
    expect(CASH_METHOD_FILTER).toEqual({ notIn: [CREDIT_NOTE_METHOD, ADVANCE_METHOD] });
  });
});

describe("CONFIRMED_STATUS / CONFIRMED_PAYMENT (unchanged by B421)", () => {
  it("still matches only PAID", () => {
    expect(CONFIRMED_STATUS).toBe("PAID");
    expect(CONFIRMED_PAYMENT).toEqual({ status: "PAID" });
  });
});
