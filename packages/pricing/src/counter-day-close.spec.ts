import {
  DAY_CLOSE_DENOMINATIONS,
  dayCloseCashFromSales,
  dayCloseDateLabel,
  dayCloseZSections,
  dayCloseWindowIsEmpty,
  DAY_CLOSE_MAX_COUNT,
  sumDenominations,
  validOpeningFloat,
  validateDenominations,
} from "./counter-day-close";

describe("dayCloseDateLabel", () => {
  it("words a calendar day as the Z title does: weekday, month, day", () => {
    expect(dayCloseDateLabel("2026-10-11")).toBe("Sun, Oct 11");
    expect(dayCloseDateLabel("2026-10-07")).toBe("Wed, Oct 7");
    expect(dayCloseDateLabel("2026-01-01")).toBe("Thu, Jan 1");
  });
  it("returns a malformed day unchanged rather than a wrong date", () => {
    expect(dayCloseDateLabel("not-a-day")).toBe("not-a-day");
  });
});

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
      dayCloseWindowIsEmpty({
        ...empty,
        moneyIn: { ...empty.moneyIn, total: 5, cash: 5 },
      } as typeof empty),
    ).toBe(false);
    expect(dayCloseWindowIsEmpty({ ...empty, refunds: { ...empty.refunds, count: 1 } })).toBe(
      false,
    );
    expect(
      dayCloseWindowIsEmpty({
        ...empty,
        storeCreditIssued: { count: 1, amount: 3 },
      } as typeof empty),
    ).toBe(false);
    expect(dayCloseWindowIsEmpty({ ...empty, notAtTill: 2 })).toBe(false);
    // a hand-over row is activity even when its amount is zero (the stored field is optional: older closes lack it)
    expect(dayCloseWindowIsEmpty({ ...empty, handOver: { count: 1 } })).toBe(false);
    expect(dayCloseWindowIsEmpty({ ...empty, handOver: { count: 0 } })).toBe(true);
  });
});

describe("dayCloseCashFromSales", () => {
  it("is the cash taken before the float and the cash refunds, rounded to cents", () => {
    expect(dayCloseCashFromSales(130, 100, 0)).toBe(30);
    expect(dayCloseCashFromSales(125, 100, 5)).toBe(30);
    expect(dayCloseCashFromSales(100.3, 100, 0)).toBe(0.3);
    expect(dayCloseCashFromSales(0.3, 0.1, 0)).toBe(0.2);
  });
});

describe("dayCloseZSections (SA-750r3 §4 order)", () => {
  const input = {
    openingFloat: 100,
    expectedCash: 415,
    countedCash: 412.5,
    variance: -2.5,
    totals: {
      moneyIn: { cash: 330, card: 40, check: 10, other: 0, total: 380 },
      refunds: { cash: 15, card: 0, check: 0, other: 0, total: 15, tenderKnown: true },
      storeCreditUsed: 0,
      storeCreditIssued: { amount: 5 },
      onAccount: 60,
      netCollected: 365,
      notAtTill: 40,
      handOver: { count: 2, cash: 50 },
    },
  };
  it("prints the headline, then Money in, Credit & account, Refunds & net, Drawer, in that order", () => {
    const z = dayCloseZSections(input);
    expect(z.headline).toEqual({ counted: 412.5, verdict: "short", amount: 2.5 });
    expect(z.groups.map((g) => g.heading)).toEqual([
      "Money in",
      "Credit & account",
      "Refunds & net",
      "Drawer",
    ]);
    expect(z.groups[0].rows.map((r) => r.label)).toEqual([
      "Cash",
      "Card",
      "Check",
      "Other",
      "Total",
      "Pickup hand-overs (in till cash)",
    ]);
    expect(z.groups[3].rows.map((r) => [r.label, r.amount])).toEqual([
      ["Opening float", 100],
      ["Cash from sales", 330],
      ["Cash in drawer", 415],
      ["Counted", 412.5],
      ["Over/short", -2.5],
    ]);
    expect(z.groups[2].rows.at(-1)).toMatchObject({ label: "Net collected", bold: true });
    expect(z.groups[3].rows[2]).toMatchObject({ label: "Cash in drawer", bold: true });
    expect(z.notTakenAtTill).toBe(40);
    expect(z.refundsTenderKnown).toBe(true);
  });
  it("every row is present at zero, over/even verdicts, and a close without handOver is 'never recorded' (null), not zero", () => {
    const zero = {
      ...input,
      variance: 0,
      totals: {
        ...input.totals,
        moneyIn: { cash: 0, card: 0, check: 0, other: 0, total: 0 },
        handOver: undefined,
      },
    };
    const z = dayCloseZSections(zero);
    expect(z.headline.verdict).toBe("even");
    expect(z.groups[0].rows.every((r) => r.amount === 0 || r.label.startsWith("Pickup"))).toBe(
      true,
    );
    expect(z.groups[0].rows.at(-1)).toEqual({
      label: "Pickup hand-overs (in till cash)",
      amount: null,
    });
    expect(dayCloseZSections({ ...input, variance: 1 }).headline).toMatchObject({
      verdict: "over",
      amount: 1,
    });
  });
});
