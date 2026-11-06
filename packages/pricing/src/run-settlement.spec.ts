import {
  computeVariance,
  expectedPhysicalCash,
  isReconciled,
  shouldForceSettlement,
  varianceNeedsReason,
} from "./run-settlement";

// SA-1098 A-1 / PR-S: the run-settlement figures live here once, so the API, the web and the
// native screen cannot disagree about when a count needs a reason (rows SE-3 and SE-13).

describe("expectedPhysicalCash", () => {
  it("is cash plus checks, and a missing checkTotal is zero", () => {
    expect(expectedPhysicalCash({ cashTotal: 40, checkTotal: 30 })).toBe(70);
    expect(expectedPhysicalCash({ cashTotal: 40 })).toBe(40);
  });

  it("is null until the payload has loaded, never a bogus $0.00", () => {
    expect(expectedPhysicalCash(null)).toBeNull();
    expect(expectedPhysicalCash(undefined)).toBeNull();
  });

  it("rounds at cents precision: 0.1 + 0.2 is 0.3", () => {
    expect(expectedPhysicalCash({ cashTotal: 0.1, checkTotal: 0.2 })).toBe(0.3);
  });
});

describe("computeVariance / isReconciled", () => {
  it("is counted minus expected at cents precision; positive is over", () => {
    expect(computeVariance(70, 70)).toBe(0);
    expect(computeVariance(70, 60)).toBe(-10);
    expect(computeVariance(0.3, 0.1 + 0.2)).toBe(0);
  });

  it("is reconciled within a cent and not beyond it", () => {
    expect(isReconciled(0.01)).toBe(true);
    expect(isReconciled(-0.01)).toBe(true);
    expect(isReconciled(0.02)).toBe(false);
    expect(isReconciled(-0.02)).toBe(false);
  });
});

describe("varianceNeedsReason (SE-3: the one rule the server and the screens share)", () => {
  it("a count within a cent of expected needs no reason", () => {
    expect(varianceNeedsReason(70, 70)).toBe(false);
    expect(varianceNeedsReason(70, 70.01)).toBe(false);
    expect(varianceNeedsReason(70, 69.99)).toBe(false);
  });

  it("two cents off needs a reason, over or short", () => {
    expect(varianceNeedsReason(70, 70.02)).toBe(true);
    expect(varianceNeedsReason(70, 69.98)).toBe(true);
    expect(varianceNeedsReason(70, 0)).toBe(true);
  });

  it("float noise never flips it: 0.1 + 0.2 counted against 0.3 is a match", () => {
    expect(varianceNeedsReason(0.3, 0.1 + 0.2)).toBe(false);
  });

  it("agrees with isReconciled(computeVariance(...)) at every cent from -5 to +5", () => {
    for (let cents = -500; cents <= 500; cents++) {
      const counted = Math.round((100 + cents / 100) * 100) / 100;
      expect(varianceNeedsReason(100, counted)).toBe(!isReconciled(computeVariance(100, counted)));
    }
  });
});

describe("shouldForceSettlement", () => {
  it("forces when cash or checks were collected and no settlement is on record", () => {
    expect(shouldForceSettlement({ collectedPayments: { cashTotal: 20 } })).toBe(true);
    expect(shouldForceSettlement({ collectedPayments: { cashTotal: 0, checkTotal: 15 } })).toBe(
      true,
    );
  });

  it("does not force once a settlementNote is on record", () => {
    expect(
      shouldForceSettlement({ collectedPayments: { cashTotal: 20 }, settlementNote: "x" }),
    ).toBe(false);
  });

  it("is false with no money, and the store signal covers the stale window", () => {
    expect(shouldForceSettlement({ collectedPayments: { cashTotal: 0, checkTotal: 0 } })).toBe(
      false,
    );
    expect(shouldForceSettlement(null)).toBe(false);
    expect(shouldForceSettlement({}, true)).toBe(true);
    expect(shouldForceSettlement({ settlementNote: "x" }, true)).toBe(false);
  });
});
