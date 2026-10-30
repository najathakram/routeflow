import {
  IMPACT_SCAN_MAX_DOCUMENTS,
  STAFF_ORDERS_SWITCH_LABEL as SHARED_LABEL,
  ruleEditImpactCopy,
} from "@routeflow/types";
import { STAFF_ORDERS_SWITCH_LABEL } from "./unknown-state";

describe("ruleEditImpactCopy", () => {
  it("switch ON (row 510): staff are warned, buyers blocked", () => {
    expect(ruleEditImpactCopy(1, false, true)).toBe(
      "1 open order has products this change now restricts. Staff will be warned when they next edit, promote or invoice it; buyers can't order it.",
    );
    expect(ruleEditImpactCopy(12, false, true)).toBe(
      "12 open orders have products this change now restricts. Staff will be warned when they next edit, promote or invoice them; buyers can't order them.",
    );
    expect(ruleEditImpactCopy(0, false, true)).toContain("0 open orders have products");
  });

  it("switch OFF (review MUST-1): buyers blocked, staff orders not checked, never 'warned'", () => {
    expect(ruleEditImpactCopy(1, false, false)).toBe(
      `1 open order has products this change now restricts. Buyers can't order it. Staff orders and invoices aren't checked (turn on '${STAFF_ORDERS_SWITCH_LABEL}' to check them).`,
    );
    for (const capped of [false, true]) {
      expect(ruleEditImpactCopy(12, capped, false)).not.toMatch(/warned/);
      expect(ruleEditImpactCopy(12, capped, false)).toContain("aren't checked");
    }
  });

  it("switch unknown (loading or failed, W-751 L1): buyers blocked, nothing claimed about staff", () => {
    expect(ruleEditImpactCopy(2, false, null)).toBe(
      "2 open orders have products this change now restricts. Buyers can't order them.",
    );
    expect(ruleEditImpactCopy(2, true, null)).not.toMatch(/[Ss]taff/);
  });

  it("the switch label is one constant (W-751 N3): the web copy quotes the shared one", () => {
    expect(STAFF_ORDERS_SWITCH_LABEL).toBe(SHARED_LABEL);
    expect(ruleEditImpactCopy(1, false, false)).toContain(`'${SHARED_LABEL}'`);
  });

  it("a capped count reads as a lower bound at the cap, formatted en-US, in both states", () => {
    expect(IMPACT_SCAN_MAX_DOCUMENTS).toBe(2000);
    expect(ruleEditImpactCopy(1800, true, true)).toBe(
      "2,000+ open orders and drafts have products this change now restricts. Staff will be warned when they next edit, promote or invoice them; buyers can't order them.",
    );
    expect(ruleEditImpactCopy(1, true, false)).toMatch(
      /^2,000\+ open orders and drafts have products .* Buyers can't order them\./,
    );
  });
});
