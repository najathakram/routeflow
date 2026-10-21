import { IMPACT_SCAN_MAX_DOCUMENTS, ruleEditImpactCopy } from "@routeflow/types";

describe("ruleEditImpactCopy", () => {
  it("keeps the uncapped wording (row 510: staff are warned, buyers blocked)", () => {
    expect(ruleEditImpactCopy(1)).toBe(
      "1 open order has products this change now restricts. Staff will be warned when they next edit or promote it; buyers can't order it.",
    );
    expect(ruleEditImpactCopy(12)).toBe(
      "12 open orders have products this change now restricts. Staff will be warned when they next edit or promote them; buyers can't order them.",
    );
    expect(ruleEditImpactCopy(0)).toContain("0 open orders have products");
  });

  it("a capped count reads as a lower bound at the cap, formatted en-US", () => {
    expect(IMPACT_SCAN_MAX_DOCUMENTS).toBe(2000);
    expect(ruleEditImpactCopy(1800, true)).toBe(
      "2,000+ open orders and drafts have products this change now restricts. Staff will be warned when they next edit or promote them; buyers can't order them.",
    );
  });
});
