import { ruleEditChanges, type RuleEditSettings } from "./rule-edit-direction";

const d = (iso: string) => new Date(iso);
const base: RuleEditSettings = {
  jurisdiction: "STATE",
  states: ["TX", "CA"],
  surface: "BUYER_PORTAL",
  effectiveFrom: d("2026-01-01T00:00:00Z"),
  effectiveTo: d("2026-12-31T00:00:00Z"),
  reason: "Portal limit",
};
const on = { staffEnforced: true };
const off = { staffEnforced: false };
const change = (over: Partial<RuleEditSettings>, opts = on) =>
  ruleEditChanges(base, { ...base, ...over }, opts);

describe("ruleEditChanges (direction of each changed field)", () => {
  it("reports nothing when nothing changed (order and spelling of states ignored)", () => {
    expect(change({})).toEqual([]);
    expect(change({ states: ["ca", "Texas"] })).toEqual([]);
  });

  it("a state added TIGHTENS, a state removed LOOSENS, both at once is the strongest: TIGHTENS", () => {
    expect(change({ states: ["TX", "CA", "NY"] })).toEqual([
      { field: "states", direction: "TIGHTENS" },
    ]);
    expect(change({ states: ["TX"] })).toEqual([{ field: "states", direction: "LOOSENS" }]);
    expect(change({ states: ["TX", "NY"] })).toEqual([{ field: "states", direction: "TIGHTENS" }]);
  });

  it("STATE to an all-customer rule TIGHTENS (and says nothing about states); the reverse LOOSENS", () => {
    expect(change({ jurisdiction: "FEDERAL", states: [] })).toEqual([
      { field: "jurisdiction", direction: "TIGHTENS" },
    ]);
    const fed: RuleEditSettings = { ...base, jurisdiction: "FEDERAL", states: [] };
    expect(ruleEditChanges(fed, base, on)).toEqual([
      { field: "jurisdiction", direction: "LOOSENS" },
    ]);
  });

  it("BUYER_PORTAL to ALL TIGHTENS only when staff are enforced; NEUTRAL with the switch off", () => {
    expect(change({ surface: "ALL" }, on)).toEqual([{ field: "surface", direction: "TIGHTENS" }]);
    expect(change({ surface: "ALL" }, off)).toEqual([{ field: "surface", direction: "NEUTRAL" }]);
    const all: RuleEditSettings = { ...base, surface: "ALL" };
    expect(ruleEditChanges(all, base, on)).toEqual([{ field: "surface", direction: "LOOSENS" }]);
    expect(ruleEditChanges(all, base, off)).toEqual([{ field: "surface", direction: "NEUTRAL" }]);
  });

  it("window: earlier start or later / removed end TIGHTENS; the reverse LOOSENS", () => {
    expect(change({ effectiveFrom: d("2025-12-01T00:00:00Z") })).toEqual([
      { field: "window", direction: "TIGHTENS" },
    ]);
    expect(change({ effectiveTo: d("2027-06-01T00:00:00Z") })).toEqual([
      { field: "window", direction: "TIGHTENS" },
    ]);
    expect(change({ effectiveTo: null })).toEqual([{ field: "window", direction: "TIGHTENS" }]);
    expect(change({ effectiveFrom: d("2026-02-01T00:00:00Z") })).toEqual([
      { field: "window", direction: "LOOSENS" },
    ]);
    expect(change({ effectiveTo: d("2026-06-01T00:00:00Z") })).toEqual([
      { field: "window", direction: "LOOSENS" },
    ]);
    const open: RuleEditSettings = { ...base, effectiveTo: null };
    expect(ruleEditChanges(open, base, on)).toEqual([{ field: "window", direction: "LOOSENS" }]);
    // one side widens, the other narrows: the strongest wins
    expect(
      change({
        effectiveFrom: d("2025-12-01T00:00:00Z"),
        effectiveTo: d("2026-06-01T00:00:00Z"),
      }),
    ).toEqual([{ field: "window", direction: "TIGHTENS" }]);
  });

  it("a reason change is NEUTRAL", () => {
    expect(change({ reason: "New reason" })).toEqual([{ field: "reason", direction: "NEUTRAL" }]);
  });

  it("lists several changed fields in the contract's field order", () => {
    expect(
      change({ states: ["TX"], surface: "ALL", reason: "x", effectiveTo: null }).map(
        (c) => c.field,
      ),
    ).toEqual(["states", "surface", "window", "reason"]);
  });
});
