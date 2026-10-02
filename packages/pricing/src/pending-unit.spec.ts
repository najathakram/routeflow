import {
  isUnitPending,
  mayMergeResolved,
  packQtyForTaps,
  pendingResolveKey,
  pendingResolvePlan,
  pendingScanDecision,
  pendingStatus,
  pendingTapCount,
  refreshUnitsAnswer,
  refusesPendingEdit,
  undoPendingTap,
} from "./pending-unit";

/**
 * #2865 case c (SA-632): a line whose default selling unit is not yet resolved is PENDING, and its
 * quantity must never depend on load timing. ONE predicate, used by web and mobile (no mirror).
 */
describe("isUnitPending (shared by web and mobile)", () => {
  it("web shape: a boolean flag marks a pending line unless the line is already shaped", () => {
    expect(isUnitPending({ startOnDefaultUnit: true })).toBe(true);
    expect(isUnitPending({ startOnDefaultUnit: true, shaped: true })).toBe(false);
    expect(isUnitPending({ startOnDefaultUnit: false })).toBe(false);
    expect(isUnitPending({})).toBe(false);
  });

  it("mobile shape: a numeric flag holds only while it equals the line's qty", () => {
    expect(isUnitPending({ startOnDefaultUnit: 12, qty: 12 })).toBe(true);
    expect(isUnitPending({ startOnDefaultUnit: 12, qty: 24 })).toBe(false);
    expect(isUnitPending({ startOnDefaultUnit: undefined, qty: 12 })).toBe(false);
  });

  it("an operator-typed price is a shaped line, never pending", () => {
    expect(isUnitPending({ startOnDefaultUnit: 12, qty: 12, operatorPrice: true })).toBe(false);
  });

  it("null / undefined flags are not pending", () => {
    expect(isUnitPending({ startOnDefaultUnit: null, qty: 1 })).toBe(false);
  });
});

describe("refusesPendingEdit (the refusal rules, one for web and mobile)", () => {
  const pending = { startOnDefaultUnit: true as const };
  const settled = { startOnDefaultUnit: false as const };

  it("a PENDING line refuses a qty edit, a typed price, a unit total and a stepper increment", () => {
    for (const intent of ["qty", "price", "unit", "increment"] as const) {
      expect(refusesPendingEdit(pending, intent)).toBe(true);
    }
  });

  it("only a default-start TAP may add to a pending line", () => {
    expect(refusesPendingEdit(pending, "tap")).toBe(false);
  });

  it("a settled line, or no line yet, is never refused", () => {
    for (const intent of ["qty", "price", "unit", "increment", "tap"] as const) {
      expect(refusesPendingEdit(settled, intent)).toBe(false);
      expect(refusesPendingEdit(undefined, intent)).toBe(false);
    }
  });

  it("lifecycle: pending refuses, a failed load keeps refusing, a successful retry allows", () => {
    const afterFailedLoad = pending; // a failed load never touches the line
    expect(refusesPendingEdit(afterFailedLoad, "qty")).toBe(true);
    const afterRetry = { startOnDefaultUnit: false as const };
    expect(refusesPendingEdit(afterRetry, "qty")).toBe(false);
  });
});

describe("pendingScanDecision (a scan landing on an existing line)", () => {
  const pending = { startOnDefaultUnit: true as const };
  it("a scan that maps to the DEFAULT unit counts as a tap", () => {
    expect(pendingScanDecision(pending, { mapsToDefault: true })).toBe("tap");
  });
  it("a scan of a DIFFERENT level is REFUSED while pending (not counted, not 'Added')", () => {
    expect(pendingScanDecision(pending, { mapsToDefault: false })).toBe("refuse");
  });
  it("a settled or absent line takes the scan as it always did", () => {
    expect(pendingScanDecision({ startOnDefaultUnit: false }, { mapsToDefault: false })).toBe(
      "add",
    );
    expect(pendingScanDecision(undefined, { mapsToDefault: false })).toBe("add");
  });
});

describe("pendingTapCount", () => {
  it("returns the recorded tap count, else the fallback, never below 1", () => {
    expect(pendingTapCount(3, 9)).toBe(3);
    expect(pendingTapCount(undefined, 2)).toBe(2);
    expect(pendingTapCount(0, 0)).toBe(1);
    expect(pendingTapCount(null, -4)).toBe(1);
  });
});

describe("pendingResolvePlan", () => {
  const base = { isStaff: true, unitsEnabled: true, unitsKnown: true };
  it("non-staff, unlisted, or units switched off settle on the pack (no ladder read)", () => {
    expect(pendingResolvePlan({ ...base, isStaff: false })).toEqual({ plan: "settle" });
    expect(pendingResolvePlan({ ...base, unlisted: true })).toEqual({ plan: "settle" });
    expect(pendingResolvePlan({ ...base, unitsEnabled: false })).toEqual({ plan: "settle" });
  });
  it("the units answer not known yet is BLOCKED as 'units-unknown', never settled", () => {
    expect(pendingResolvePlan({ ...base, unitsKnown: false })).toEqual({
      plan: "blocked",
      reason: "units-unknown",
    });
  });
  it("a missing product record is blocked; a known, enabled staff line fetches the ladder", () => {
    expect(pendingResolvePlan({ ...base, productKnown: false })).toEqual({
      plan: "blocked",
      reason: "product-missing",
    });
    expect(pendingResolvePlan(base)).toEqual({ plan: "fetch" });
  });
});

describe("pendingStatus (M1: loading is never reported as a failure)", () => {
  it("a settled line has no status", () => {
    expect(pendingStatus(false, {})).toBeUndefined();
  });
  it("a pending line is LOADING until something actually failed", () => {
    expect(pendingStatus(true, {})).toBe("loading");
    expect(pendingStatus(true, { reason: "units-unknown" })).toBe("loading");
  });
  it("units-unknown becomes FAILED only once the subscription read itself failed", () => {
    expect(pendingStatus(true, { reason: "units-unknown", subscriptionFailed: true })).toBe(
      "failed",
    );
  });
  it("a failed ladder fetch, or a missing product, is FAILED", () => {
    expect(pendingStatus(true, { reason: "ladder-failed" })).toBe("failed");
    expect(pendingStatus(true, { reason: "product-missing" })).toBe("failed");
  });
});

describe("mayMergeResolved (an async resolve never overwrites what the user did meanwhile)", () => {
  const pending = { startOnDefaultUnit: true as const };
  it("merges only into a still-pending line at the same tap count", () => {
    expect(mayMergeResolved({ cur: pending, curCount: 2, beforeCount: 2, changed: true })).toBe(
      true,
    );
    expect(mayMergeResolved({ cur: pending, curCount: 3, beforeCount: 2, changed: true })).toBe(
      false,
    );
    expect(
      mayMergeResolved({
        cur: { startOnDefaultUnit: false },
        curCount: 2,
        beforeCount: 2,
        changed: true,
      }),
    ).toBe(false);
    expect(mayMergeResolved({ cur: undefined, curCount: 1, beforeCount: 1, changed: true })).toBe(
      false,
    );
    expect(mayMergeResolved({ cur: pending, curCount: 2, beforeCount: 2, changed: false })).toBe(
      false,
    );
  });
});

describe("refreshUnitsAnswer ('Try again' refetches an unknown units answer)", () => {
  const deps = { isStaff: true, unitsEnabled: false, unitsKnown: false, other: 1 };
  it("a STAFF caller with an unknown answer refetches and adopts it", async () => {
    const out = await refreshUnitsAnswer(
      deps,
      async () => ({ isSuccess: true, flags: ["flag.units_v1"] }),
      "flag.units_v1",
    );
    expect(out).toEqual({ ...deps, unitsKnown: true, unitsEnabled: true });
  });
  it("a failed or throwing refetch, a known answer or a non-staff caller leave the deps as they were", async () => {
    const fail = async () => ({ isSuccess: false, flags: [] as string[] });
    expect(await refreshUnitsAnswer(deps, fail, "f")).toBe(deps);
    expect(
      await refreshUnitsAnswer(
        deps,
        async () => {
          throw new Error("x");
        },
        "f",
      ),
    ).toBe(deps);
    const known = { ...deps, unitsKnown: true };
    expect(await refreshUnitsAnswer(known, fail, "f")).toBe(known);
    const driver = { ...deps, isStaff: false };
    expect(await refreshUnitsAnswer(driver, fail, "f")).toBe(driver);
  });
});

describe("undoPendingTap (N2: Undo on a PENDING line takes one TAP back, never settles a unit)", () => {
  it("decrements the tap count; at the creating scan (1 tap) the line is REMOVED", () => {
    expect(undoPendingTap(3)).toEqual({ remove: false, taps: 2 });
    expect(undoPendingTap(2)).toEqual({ remove: false, taps: 1 });
    expect(undoPendingTap(1)).toEqual({ remove: true });
    expect(undoPendingTap(undefined)).toEqual({ remove: true });
  });
});

describe("pendingResolveKey (N1: the resolver re-runs when a tap lands during the fetch)", () => {
  it("changes with the tap count, so a tap during the fetch re-runs the resolver", () => {
    const one = pendingResolveKey([{ id: "p1", count: 1 }]);
    const two = pendingResolveKey([{ id: "p1", count: 2 }]);
    expect(one).not.toBe(two);
    expect(
      pendingResolveKey([
        { id: "a", count: 1 },
        { id: "b", count: 2 },
      ]),
    ).toBe("a:1|b:2");
    expect(pendingResolveKey([])).toBe("");
  });
});

describe("packQtyForTaps (N3: a settle on the PACK keeps the tap count)", () => {
  it("a case-packed line settles to N whole cases (boxes N, qty N x units per box)", () => {
    expect(packQtyForTaps(3, 12)).toEqual({ boxes: 3, pieces: 0, qty: 36 });
    expect(packQtyForTaps(1, 12)).toEqual({ boxes: 1, pieces: 0, qty: 12 });
  });
  it("a plain line settles to qty N; no recorded taps is ONE pack", () => {
    expect(packQtyForTaps(3, 1)).toEqual({ qty: 3 });
    expect(packQtyForTaps(3, null)).toEqual({ qty: 3 });
    expect(packQtyForTaps(undefined, 12)).toEqual({ boxes: 1, pieces: 0, qty: 12 });
  });
});
