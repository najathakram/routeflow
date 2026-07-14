import {
  summarizeCollections,
  computeVariance,
  isReconciled,
  buildSettlementNote,
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
