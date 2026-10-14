import { IMPACT_SCAN_MAX_DOCUMENTS, ruleEditImpactCopy } from "@routeflow/types";

describe("ruleEditImpactCopy", () => {
  it("keeps the uncapped wording", () => {
    expect(ruleEditImpactCopy(1)).toBe(
      "1 open order has products this change now restricts. They'll be checked when they're next edited, promoted or invoiced.",
    );
    expect(ruleEditImpactCopy(12)).toBe(
      "12 open orders have products this change now restricts. They'll be checked when they're next edited, promoted or invoiced.",
    );
    expect(ruleEditImpactCopy(0)).toContain("0 open orders have products");
  });

  it("a capped count reads as a lower bound at the cap, formatted en-US", () => {
    expect(IMPACT_SCAN_MAX_DOCUMENTS).toBe(2000);
    expect(ruleEditImpactCopy(1800, true)).toBe(
      "2,000+ open orders and drafts have products this change now restricts. They'll be checked when they're next edited, promoted or invoiced.",
    );
  });
});
