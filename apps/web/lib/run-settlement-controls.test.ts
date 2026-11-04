import {
  driverRunFooter,
  officeSettlementControls,
  runHoldsMoney,
} from "./run-settlement-controls";

// SA-1098 A-1 (PR-S): which settlement control a run shows. One function per surface so the driver's
// footer and the office card cannot drift (rows SE-1, SE-5, SE-8, SE-12).

type Stop = { status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "SKIPPED" };
const done: Stop[] = [{ status: "COMPLETED" }, { status: "SKIPPED" }];
const left: Stop[] = [{ status: "COMPLETED" }, { status: "PENDING" }];
const cash = { cashTotal: 60, checkTotal: 0, count: 1 };
const check = { cashTotal: 0, checkTotal: 25, count: 1 };
const none = { cashTotal: 0, checkTotal: 0, count: 0 };

function run(over: Record<string, unknown>) {
  return {
    status: "IN_PROGRESS",
    stops: done,
    collectedPayments: cash,
    settlementNote: null,
    ...over,
  } as any;
}

describe("runHoldsMoney (the gate reads the figure, never the add-on)", () => {
  it("is true for cash, true for checks alone, false for nothing or an unloaded payload", () => {
    expect(runHoldsMoney(run({}))).toBe(true);
    expect(runHoldsMoney(run({ collectedPayments: check }))).toBe(true);
    expect(runHoldsMoney(run({ collectedPayments: none }))).toBe(false);
    expect(runHoldsMoney(run({ collectedPayments: null }))).toBe(false);
    expect(runHoldsMoney(run({ collectedPayments: undefined }))).toBe(false);
  });
});

describe("driverRunFooter", () => {
  it("SE-1: cash held, nothing settled, no stop left: Settle your run", () => {
    expect(driverRunFooter(run({}))).toBe("SETTLE");
    expect(driverRunFooter(run({ collectedPayments: check }))).toBe("SETTLE");
  });

  it("SE-5: settled (note on record), no stop left: Finish route, never Settle again", () => {
    expect(driverRunFooter(run({ settlementNote: "Settlement recorded" }))).toBe("FINISH");
  });

  it("SE-12: no physical money: Finish route, never Settle", () => {
    expect(driverRunFooter(run({ collectedPayments: none }))).toBe("FINISH");
  });

  it("a run with no stops at all can still be finished", () => {
    expect(driverRunFooter(run({ stops: [], collectedPayments: none }))).toBe("FINISH");
  });

  it("nothing is offered while a stop is left, or on a run that is not in progress", () => {
    expect(driverRunFooter(run({ stops: left }))).toBeNull();
    expect(driverRunFooter(run({ stops: [{ status: "IN_PROGRESS" }] }))).toBeNull();
    for (const status of ["SCHEDULED", "COMPLETED", "CANCELLED"]) {
      expect(driverRunFooter(run({ status }))).toBeNull();
    }
  });

  it("nothing is offered when the stops did not load", () => {
    expect(driverRunFooter(run({ stops: undefined }))).toBeNull();
  });
});

describe("officeSettlementControls (SE-8)", () => {
  const off = { settle: false, finish: false, amend: false };

  it("in progress, no stop left, money unsettled: Settle run (Finish waits for it)", () => {
    expect(officeSettlementControls(run({}), true)).toEqual({ ...off, settle: true });
  });

  it("in progress, no stop left, settled or no money: Finish run", () => {
    expect(officeSettlementControls(run({ settlementNote: "x" }), true)).toEqual({
      ...off,
      finish: true,
    });
    expect(officeSettlementControls(run({ collectedPayments: none }), true)).toEqual({
      ...off,
      finish: true,
    });
  });

  it("cancelled with money collected: Settle run, never Finish", () => {
    expect(officeSettlementControls(run({ status: "CANCELLED" }), true)).toEqual({
      ...off,
      settle: true,
    });
  });

  it("completed or cancelled and already settled: Amend", () => {
    for (const status of ["COMPLETED", "CANCELLED"]) {
      expect(officeSettlementControls(run({ status, settlementNote: "x" }), true)).toEqual({
        ...off,
        amend: true,
      });
    }
  });

  it("scheduled, or in progress with stops left: nothing new", () => {
    expect(officeSettlementControls(run({ status: "SCHEDULED" }), true)).toEqual(off);
    expect(officeSettlementControls(run({ stops: left }), true)).toEqual(off);
  });

  it("SE-16: completed with money and no note shows no Settle (it cannot happen); cancelled still does", () => {
    expect(officeSettlementControls(run({ status: "COMPLETED" }), true)).toEqual(off);
    expect(officeSettlementControls(run({ status: "CANCELLED" }), true)).toEqual({
      ...off,
      settle: true,
    });
  });

  it("completed or cancelled with no money and no note: nothing", () => {
    expect(
      officeSettlementControls(run({ status: "COMPLETED", collectedPayments: none }), true),
    ).toEqual(off);
  });

  it("never for a non-operator", () => {
    expect(officeSettlementControls(run({}), false)).toEqual(off);
  });
});
