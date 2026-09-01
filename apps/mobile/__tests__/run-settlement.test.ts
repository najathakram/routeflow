import {
  summarizeCollections,
  computeVariance,
  expectedPhysicalCash,
  isReconciled,
  buildSettlementNote,
  shouldForceSettlement,
} from "../lib/run-settlement";

const entries = [
  { stopId: "s1", method: "CASH" as const, amount: 40, collectedAt: 1 },
  { stopId: "s2", method: "CASH" as const, amount: 25.5, collectedAt: 2 },
  { stopId: "s3", method: "CHECK" as const, amount: 100, collectedAt: 3 },
  { stopId: "s4", method: "CREDIT_CARD" as const, amount: 60, collectedAt: 4 },
];

describe("summarizeCollections", () => {
  it("groups by method and sums cash+check separately from card", () => {
    const s = summarizeCollections(entries);
    expect(s.byMethod.CASH).toBe(65.5);
    expect(s.byMethod.CHECK).toBe(100);
    expect(s.byMethod.CREDIT_CARD).toBe(60);
    expect(s.cashTotal).toBe(165.5);
    expect(s.total).toBe(225.5);
    expect(s.count).toBe(4);
  });

  it("handles an empty run", () => {
    expect(summarizeCollections([])).toEqual({ byMethod: {}, cashTotal: 0, total: 0, count: 0 });
  });
});

describe("computeVariance / isReconciled", () => {
  it("is reconciled at exact match", () => {
    expect(computeVariance(100, 100)).toBe(0);
    expect(isReconciled(computeVariance(100, 100))).toBe(true);
  });

  it("flags an over/short variance beyond a penny", () => {
    expect(computeVariance(100, 95)).toBe(-5);
    expect(isReconciled(-5)).toBe(false);
    expect(computeVariance(100, 105.5)).toBe(5.5);
  });

  it("tolerates a sub-penny rounding difference", () => {
    expect(isReconciled(computeVariance(100.005, 100))).toBe(true);
  });
});

describe("buildSettlementNote", () => {
  it("includes the status and both numbers, reconciled case", () => {
    const note = buildSettlementNote({
      expectedCash: 100,
      countedCash: 100,
      variance: 0,
      overridden: false,
      driverLabel: "J. Diaz",
      when: new Date("2026-07-14T18:30:00"),
    });
    expect(note).toContain("expected $100.00");
    expect(note).toContain("counted $100.00");
    expect(note).toContain("variance +$0.00");
    expect(note).toContain("(reconciled)");
    expect(note).toContain("J. Diaz");
  });

  it("marks an overridden variance", () => {
    const note = buildSettlementNote({
      expectedCash: 100,
      countedCash: 90,
      variance: -10,
      overridden: true,
      driverLabel: "J. Diaz",
    });
    expect(note).toContain("variance -$10.00");
    expect(note).toContain("(override)");
  });
});

// REG-B152: the settlement screen's expected figure and the gate share ONE basis —
// physical money = CASH + CHECK. The server payload splits the two, so a consumer
// reading `cashTotal` alone reconciles a check-carrying run against the wrong figure
// and manufactures a variance the driver is then forced to explain.
describe("expectedPhysicalCash (REG-B152)", () => {
  it("folds checks into the expected figure", () => {
    expect(expectedPhysicalCash({ cashTotal: 100, checkTotal: 50 })).toBe(150);
  });

  it("treats a missing checkTotal as zero", () => {
    expect(expectedPhysicalCash({ cashTotal: 100 })).toBe(100);
  });

  it("is null when the payload has not loaded, so callers can fall back", () => {
    expect(expectedPhysicalCash(undefined)).toBeNull();
    expect(expectedPhysicalCash(null)).toBeNull();
  });
});

// REG-B152: server-truth settlement gate (spec R8, test-plan T-B152m). `run.notes` /
// `runSettlementStore` staleness is why the store-signal OR fallback exists — see the
// fourth case below.
describe("shouldForceSettlement (REG-B152)", () => {
  it("forces settlement when cash was collected and no settlement note exists yet", () => {
    expect(
      shouldForceSettlement({
        collectedPayments: { cashTotal: 40, checkTotal: 0, count: 1 },
        settlementNote: null,
      }),
    ).toBe(true);
  });

  it("forces settlement on check-only collections too (cash+check basis)", () => {
    expect(
      shouldForceSettlement({
        collectedPayments: { cashTotal: 0, checkTotal: 25, count: 1 },
        settlementNote: null,
      }),
    ).toBe(true);
  });

  it("does not force settlement once a settlementNote is already on record", () => {
    expect(
      shouldForceSettlement({
        collectedPayments: { cashTotal: 40, checkTotal: 0, count: 1 },
        settlementNote: "already settled",
      }),
    ).toBe(false);
  });

  it("ORs in the store signal when the run payload has no collectedPayments yet", () => {
    // Missing collectedPayments (query staleness right after a collection) + a true
    // store signal must still force settlement — an AND here would strand this case.
    expect(shouldForceSettlement({ settlementNote: null }, true)).toBe(true);
  });

  it("is false when there is neither a cash/check total nor a store signal", () => {
    expect(shouldForceSettlement({ settlementNote: null }, false)).toBe(false);
  });
});
