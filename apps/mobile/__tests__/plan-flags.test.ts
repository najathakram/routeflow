/**
 * Lite-L2 (WP11/WP12): pure-logic coverage for `lib/plan-flags.ts`. Mobile tests are
 * pure-logic only (CLAUDE.md) — the hooks (useSubscription/usePlanFlag) are not tested
 * here; this file proves `planLockedSection` (the operator route-group lock,
 * WP12/(operator)/_layout.tsx) and `planFlagVisible` (the More-screen row hiding,
 * WP12/(tabs)/more.tsx).
 */
import { PLAN_GATED_SECTIONS, planFlagVisible, planLockedSection } from "../lib/plan-flags";

function segments(...tail: string[]): string[] {
  return ["(operator)", ...tail];
}

describe("planLockedSection", () => {
  it("locks a gated section the tenant's flags do not include", () => {
    const key = planLockedSection(segments("(tabs)", "estimates"), {
      flags: [],
      resolved: true,
      failed: false,
    });
    expect(key).toBe("flag.estimates");
  });

  it("does not lock when the flag is present", () => {
    const key = planLockedSection(segments("(tabs)", "estimates"), {
      flags: ["flag.estimates"],
      resolved: true,
      failed: false,
    });
    expect(key).toBeNull();
  });

  it("fails OPEN while unresolved (still loading)", () => {
    const key = planLockedSection(segments("(tabs)", "estimates"), {
      flags: [],
      resolved: false,
      failed: false,
    });
    expect(key).toBeNull();
  });

  it("fails OPEN when the fetch failed", () => {
    const key = planLockedSection(segments("(tabs)", "estimates"), {
      flags: [],
      resolved: true,
      failed: true,
    });
    expect(key).toBeNull();
  });

  it("returns null for an ungated section (e.g. expenses, finance, purchase-orders)", () => {
    for (const sec of ["expenses", "finance", "purchase-orders", "statements"]) {
      const key = planLockedSection(segments("(tabs)", sec), {
        flags: [],
        resolved: true,
        failed: false,
      });
      expect(key).toBeNull();
    }
  });

  it("works when the section is not nested under (tabs)", () => {
    const key = planLockedSection(segments("returns"), {
      flags: [],
      resolved: true,
      failed: false,
    });
    expect(key).toBe("flag.returns");
  });

  it("covers every PLAN_GATED_SECTIONS entry", () => {
    for (const [section, flag] of Object.entries(PLAN_GATED_SECTIONS)) {
      const key = planLockedSection(segments("(tabs)", section), {
        flags: [],
        resolved: true,
        failed: false,
      });
      expect(key).toBe(flag);
    }
  });

  it("fails OPEN when flags is undefined (absent key on the response), even though resolved", () => {
    // Finding 5: an old API build can resolve successfully with the `flags` key entirely
    // absent. That must read as "unresolved gate" (fail open), never as "resolved, zero
    // grants" the way `flags ?? []` used to collapse it.
    const key = planLockedSection(segments("(tabs)", "estimates"), {
      flags: undefined,
      resolved: true,
      failed: false,
    });
    expect(key).toBeNull();
  });

  it("still locks on a real empty grant list (flags: [])", () => {
    const key = planLockedSection(segments("(tabs)", "estimates"), {
      flags: [],
      resolved: true,
      failed: false,
    });
    expect(key).toBe("flag.estimates");
  });
});

describe("planFlagVisible", () => {
  it("resolved: goes by enabled", () => {
    expect(planFlagVisible({ enabled: true, resolved: true, failed: false })).toBe(true);
    expect(planFlagVisible({ enabled: false, resolved: true, failed: false })).toBe(false);
  });

  it("unresolved (still loading): hidden regardless of enabled", () => {
    expect(planFlagVisible({ enabled: true, resolved: false, failed: false })).toBe(false);
  });

  it("fetch failed: shown (client fails OPEN)", () => {
    expect(planFlagVisible({ enabled: false, resolved: false, failed: true })).toBe(true);
  });
});
