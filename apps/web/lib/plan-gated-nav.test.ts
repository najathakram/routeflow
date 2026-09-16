import { PLAN_GATED_NAV, matchPlanGatedRoute, planFlagVisible } from "./plan-gated-nav";

describe("matchPlanGatedRoute", () => {
  it("matches every PLAN_GATED_NAV prefix exactly", () => {
    for (const [prefix, key] of Object.entries(PLAN_GATED_NAV)) {
      expect(matchPlanGatedRoute(prefix)).toBe(key);
    }
  });

  it("matches a nested path under a gated prefix", () => {
    expect(matchPlanGatedRoute("/estimates/123")).toBe("flag.estimates");
    expect(matchPlanGatedRoute("/finance/reports/export")).toBe("flag.reports");
  });

  it("does not prefix-match a sibling path that merely starts with the same characters", () => {
    // "/returns-policy" starts with "/returns" as a raw string but is not "/returns" or
    // "/returns/..." — the exact-or-slash-boundary check must reject it.
    expect(matchPlanGatedRoute("/returns-policy")).toBeNull();
  });

  it("returns null for an ungated route", () => {
    expect(matchPlanGatedRoute("/dashboard")).toBeNull();
    expect(matchPlanGatedRoute("/orders")).toBeNull();
    expect(matchPlanGatedRoute("/sales-agents")).toBeNull();
  });
});

describe("planFlagVisible", () => {
  it("resolved: goes by enabled", () => {
    expect(planFlagVisible({ enabled: true, resolved: true, failed: false })).toBe(true);
    expect(planFlagVisible({ enabled: false, resolved: true, failed: false })).toBe(false);
  });

  it("unresolved (still loading): hidden regardless of enabled", () => {
    expect(planFlagVisible({ enabled: true, resolved: false, failed: false })).toBe(false);
    expect(planFlagVisible({ enabled: false, resolved: false, failed: false })).toBe(false);
  });

  it("fetch failed: shown (client fails OPEN)", () => {
    expect(planFlagVisible({ enabled: false, resolved: false, failed: true })).toBe(true);
  });
});
