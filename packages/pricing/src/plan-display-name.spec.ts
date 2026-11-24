import { PLAN_DISPLAY_NAMES, planDisplayName } from "./plan-display-name";

/** SA-1254 V7 (P-45): one display name per plan key; CORE is Essentials and ALL_IN is Pro. */
describe("planDisplayName", () => {
  it("names CORE Essentials and ALL_IN Pro", () => {
    expect(planDisplayName("CORE")).toBe("Essentials");
    expect(planDisplayName("ALL_IN")).toBe("Pro");
  });

  it("names every other plan as it reads today", () => {
    expect(planDisplayName("LITE")).toBe("Lite");
    expect(planDisplayName("STARTER")).toBe("Starter");
    expect(planDisplayName("GROWTH")).toBe("Growth");
    expect(planDisplayName("SCALE")).toBe("Scale");
    expect(planDisplayName("ENTERPRISE")).toBe("Enterprise");
  });

  it("has no name for a legacy alias, an unknown key or an inherited property", () => {
    for (const key of [
      "TEAM",
      "BUSINESS",
      "PROFESSIONAL",
      "PLUS",
      "PRO",
      "constructor",
      "__proto__",
    ]) {
      expect(`${key}: ${planDisplayName(key)}`).toBe(`${key}: undefined`);
    }
    expect(planDisplayName(null)).toBeUndefined();
    expect(planDisplayName(undefined)).toBeUndefined();
    expect(planDisplayName("")).toBeUndefined();
  });

  it("no name is a raw key", () => {
    for (const [key, name] of Object.entries(PLAN_DISPLAY_NAMES)) {
      expect(name).not.toBe(key);
      expect(name).not.toMatch(/_/);
    }
  });

  it("the map cannot be changed at run time", () => {
    expect(Object.isFrozen(PLAN_DISPLAY_NAMES)).toBe(true);
  });
});
