import {
  summarizeCollections,
  computeVariance,
  expectedPhysicalCash,
  isReconciled,
  buildSettlementNote,
  shouldForceSettlement,
  buildSettlementRows,
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

// B1008 (SA-644): the per-method rows must come from the SAME server payload as the total the driver
// reconciles against, so they can never disagree (the rows used to be this device's own tally).
describe("buildSettlementRows (B1008)", () => {
  const sumPhysical = (rows: { method: string; amount: number }[]) =>
    Math.round(
      rows
        .filter((r) => r.method === "CASH" || r.method === "CHECK")
        .reduce((a, r) => a + r.amount, 0) * 100,
    ) / 100;

  it("(a) after a reinstall (no local entries) the CASH and CHECK rows still come from the server and sum to the total", () => {
    const collected = { cashTotal: 70, checkTotal: 25, count: 3 };
    const out = buildSettlementRows(collected, []);
    expect(out.rows).toEqual([
      { method: "CASH", amount: 70, basis: "server" },
      { method: "CHECK", amount: 25, basis: "server" },
    ]);
    expect(out.serverLoaded).toBe(true);
    expect(sumPhysical(out.rows)).toBe(expectedPhysicalCash(collected));
    expect(sumPhysical(out.rows)).toBe(95);
  });

  it("(b) a stale local CASH entry never overrides the server: the CASH row is 70, not 40", () => {
    const out = buildSettlementRows({ cashTotal: 70, checkTotal: 0, count: 2 }, [
      { stopId: "s1", method: "CASH", amount: 40, collectedAt: 1 },
    ]);
    expect(out.rows).toEqual([{ method: "CASH", amount: 70, basis: "server" }]);
  });

  it("(c) before the run payload has loaded the rows are this device's tally, device-basis, and serverLoaded is false", () => {
    const out = buildSettlementRows(null, entries);
    expect(out.rows).toEqual([
      { method: "CASH", amount: 65.5, basis: "device" },
      { method: "CHECK", amount: 100, basis: "device" },
    ]);
    expect(out.serverLoaded).toBe(false);
  });

  it("(d) card, Zelle, advance and other are NOT in the reconciliation rows: they come back separately, from this device", () => {
    const out = buildSettlementRows({ cashTotal: 70, checkTotal: 25, count: 3 }, [
      { stopId: "s4", method: "CREDIT_CARD", amount: 60, collectedAt: 4 },
      { stopId: "s5", method: "ZELLE", amount: 10, collectedAt: 5 },
    ]);
    expect(out.rows.map((r) => r.method)).toEqual(["CASH", "CHECK"]);
    expect(out.deviceOnly).toEqual([
      { method: "ZELLE", amount: 10, basis: "device" },
      { method: "CREDIT_CARD", amount: 60, basis: "device" },
    ]);
  });

  it("(e) a server payload with nothing collected shows no cash/check rows, even if this device queued one (rows = total)", () => {
    const collected = { cashTotal: 0, checkTotal: 0, count: 0 };
    const out = buildSettlementRows(collected, [
      { stopId: "s1", method: "CASH", amount: 40, collectedAt: 1 },
    ]);
    expect(out.rows).toEqual([]);
    expect(out.serverLoaded).toBe(true); // a loaded zero is still loaded: the run can close
    expect(sumPhysical(out.rows)).toBe(expectedPhysicalCash(collected));
  });

  it("(f) the cash and check rows sum to the server total at cents precision (0.1 + 0.2 = 0.3)", () => {
    const collected = { cashTotal: 0.1, checkTotal: 0.2, count: 2 };
    expect(sumPhysical(buildSettlementRows(collected, []).rows)).toBe(
      expectedPhysicalCash(collected),
    );
  });

  it("(g) a payload without checkTotal still loads (checks count as 0), and undefined is NOT loaded", () => {
    expect(buildSettlementRows({ cashTotal: 5 }, []).serverLoaded).toBe(true);
    expect(buildSettlementRows(undefined, []).serverLoaded).toBe(false);
  });
});
