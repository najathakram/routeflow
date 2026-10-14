import { impactHash, newlyRestricted } from "./rule-edit-impact";
import type { RuleEditSettings } from "./rule-edit-direction";

const prev: RuleEditSettings = {
  jurisdiction: "STATE",
  states: ["TX"],
  surface: "ALL",
  effectiveFrom: new Date("2026-01-01T00:00:00Z"),
  effectiveTo: null,
  reason: "r",
};
const at = new Date("2026-06-01T00:00:00Z");
const tx = { resolved: true, state: "TX" } as const;
const ca = { resolved: true, state: "CA" } as const;
const none = { resolved: false } as const;
const opts = { staffEnforced: true, at };

describe("newlyRestricted (restricted by the NEW settings and not by the OLD)", () => {
  it("a customer in a state the edit adds is newly restricted; one already restricted is not", () => {
    const next = { ...prev, states: ["TX", "CA"] };
    expect(newlyRestricted(prev, next, ca, opts)).toBe(true);
    expect(newlyRestricted(prev, next, tx, opts)).toBe(false);
    expect(newlyRestricted(prev, next, { resolved: true, state: "NY" }, opts)).toBe(false);
  });

  it("a state REMOVED newly restricts nobody", () => {
    expect(newlyRestricted({ ...prev, states: ["TX", "CA"] }, prev, ca, opts)).toBe(false);
  });

  it("a customer with no resolvable state: a legal ban (surface ALL) already hides, so adding states changes nothing", () => {
    expect(newlyRestricted(prev, { ...prev, states: ["TX", "CA"] }, none, opts)).toBe(false);
  });

  it("an edit into an all-customer rule newly restricts every customer outside the old states", () => {
    const next: RuleEditSettings = { ...prev, jurisdiction: "FEDERAL", states: [] };
    expect(newlyRestricted(prev, next, ca, opts)).toBe(true);
    expect(newlyRestricted(prev, next, tx, opts)).toBe(false);
  });

  it("BUYER_PORTAL to ALL newly restricts a TX customer on the staff channel only when staff are enforced", () => {
    const portal = { ...prev, surface: "BUYER_PORTAL" as const };
    expect(newlyRestricted(portal, prev, tx, opts)).toBe(true);
    expect(newlyRestricted(portal, prev, tx, { ...opts, staffEnforced: false })).toBe(false);
  });

  it("judges a window that has not started yet at its start, so a scheduled rule's added state counts", () => {
    const future = {
      ...prev,
      effectiveFrom: new Date("2026-09-01T00:00:00Z"),
    };
    expect(newlyRestricted(future, { ...future, states: ["TX", "CA"] }, ca, opts)).toBe(true);
  });

  it("an edit that ends the rule before it can bind restricts nobody new", () => {
    const next = { ...prev, states: ["TX", "CA"], effectiveTo: new Date("2026-02-01T00:00:00Z") };
    expect(newlyRestricted(prev, next, ca, opts)).toBe(false);
  });
});

describe("impactHash", () => {
  it("is order-independent, and changes with the rule, the revision or any id", () => {
    const h = impactHash("r1", 2, ["o:b", "o:a"]);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(impactHash("r1", 2, ["o:a", "o:b"])).toBe(h);
    expect(impactHash("r2", 2, ["o:a", "o:b"])).not.toBe(h);
    expect(impactHash("r1", 3, ["o:a", "o:b"])).not.toBe(h);
    expect(impactHash("r1", 2, ["o:a", "o:b", "o:c"])).not.toBe(h);
    expect(impactHash("r1", 2, [])).toMatch(/^[0-9a-f]{64}$/);
  });
});
