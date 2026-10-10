import {
  DAY_CLOSE_DENOMINATIONS,
  dayCloseWindowIsEmpty,
  DAY_CLOSE_MAX_COUNT,
  sumDenominations,
  validOpeningFloat,
  validateDenominations,
} from "./counter-day-close";

describe("sumDenominations", () => {
  it("rounds every row to cents: 0.10 x 3 is 0.30", () => {
    expect(sumDenominations([{ kind: "coin", value: 0.1, count: 3 }])).toBe(0.3);
    expect(sumDenominations([{ kind: "coin", value: 0.05, count: 7 }])).toBe(0.35);
    expect(sumDenominations([{ kind: "coin", value: 0.01, count: 33 }])).toBe(0.33);
  });
  it("adds bills and coins, and the $1 bill is not the $1 coin", () => {
    expect(
      sumDenominations([
        { kind: "bill", value: 100, count: 2 },
        { kind: "bill", value: 1, count: 4 },
        { kind: "coin", value: 1, count: 3 },
        { kind: "coin", value: 0.25, count: 4 },
      ]),
    ).toBe(208);
  });
  it("is exact for the largest legal drawer", () => {
    const all = DAY_CLOSE_DENOMINATIONS.map((d) => ({ ...d, count: DAY_CLOSE_MAX_COUNT }));
    expect(sumDenominations(all)).toBe(18_941_000); // (188 + 1.41) per set x 100 000
  });
  it("an empty drawer is 0", () => expect(sumDenominations([])).toBe(0));
});

describe("validateDenominations", () => {
  it("keeps listed rows, drops zero counts and sorts into display order", () => {
    expect(
      validateDenominations([
        { kind: "coin", value: 0.25, count: 4 },
        { kind: "bill", value: 20, count: 0 },
        { kind: "bill", value: 5, count: 2 },
      ]),
    ).toEqual([
      { kind: "bill", value: 5, count: 2 },
      { kind: "coin", value: 0.25, count: 4 },
    ]);
  });
  it("refuses an unlisted value, a wrong kind, a duplicate, a fraction, a negative and an oversized count", () => {
    for (const bad of [
      [{ kind: "bill", value: 3, count: 1 }],
      [{ kind: "coin", value: 100, count: 1 }],
      [{ kind: "note", value: 1, count: 1 }],
      [
        { kind: "bill", value: 5, count: 1 },
        { kind: "bill", value: 5, count: 2 },
      ],
      [{ kind: "bill", value: 5, count: 1.5 }],
      [{ kind: "bill", value: 5, count: -1 }],
      [{ kind: "bill", value: 5, count: DAY_CLOSE_MAX_COUNT + 1 }],
      [{ kind: "bill", value: "5", count: 1 }],
      [null],
      "x",
      {},
    ]) {
      expect(validateDenominations(bad)).toBeNull();
    }
  });
  it("accepts an empty list and the largest legal count", () => {
    expect(validateDenominations([])).toEqual([]);
    expect(
      validateDenominations([{ kind: "bill", value: 1, count: DAY_CLOSE_MAX_COUNT }]),
    ).toHaveLength(1);
  });
});

describe("validOpeningFloat", () => {
  it("whole cents, 0 or more, finite", () => {
    for (const ok of [0, 50, 100.25, 0.01]) expect(validOpeningFloat(ok)).toBe(true);
    for (const bad of [-1, 1.005, NaN, Infinity, "5", null, undefined, 1_000_001]) {
      expect(validOpeningFloat(bad)).toBe(false);
    }
  });
});

describe("dayCloseWindowIsEmpty", () => {
  const empty = {
    salesCount: 0,
    salesTotal: 0,
    moneyIn: { cash: 0, card: 0, check: 0, other: 0, total: 0 },
    refunds: {
      count: 0,
      cash: 0,
      card: 0,
      check: 0,
      other: 0,
      total: 0,
      tenderKnown: true,
      unknownTenderCount: 0,
    },
    storeCreditUsed: 0,
    storeCreditIssued: { count: 0, amount: 0 },
    onAccount: 0,
    netCollected: 0,
    notAtTill: 0,
  };
  it("is true only when nothing happened", () => {
    expect(dayCloseWindowIsEmpty(empty)).toBe(true);
    expect(dayCloseWindowIsEmpty({ ...empty, salesCount: 1 })).toBe(false);
    expect(
      dayCloseWindowIsEmpty({ ...empty, moneyIn: { ...empty.moneyIn, total: 5, cash: 5 } }),
    ).toBe(false);
    expect(dayCloseWindowIsEmpty({ ...empty, refunds: { ...empty.refunds, count: 1 } })).toBe(
      false,
    );
    expect(dayCloseWindowIsEmpty({ ...empty, storeCreditIssued: { count: 1, amount: 3 } })).toBe(
      false,
    );
    expect(dayCloseWindowIsEmpty({ ...empty, notAtTill: 2 })).toBe(false);
  });
});
