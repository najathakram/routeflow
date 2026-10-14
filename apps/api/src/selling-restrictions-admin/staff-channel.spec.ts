import * as fs from "fs";
import * as path from "path";
import { ruleEditImpactCopy } from "@routeflow/types";
import { staffChannelJudged } from "./staff-channel";
import { ruleEditChanges, type RuleEditSettings } from "./rule-edit-direction";

/** SA cross-row ruling: the staff-channel question has ONE answer, and the edit code asks only it. */
describe("staffChannelJudged", () => {
  it("is ALWAYS true since row 510: the tenant switch is gone, whatever policy the caller holds", () => {
    expect(staffChannelJudged({ addressPrecedence: "BILLING_FIRST" })).toBe(true);
    expect(staffChannelJudged({ addressPrecedence: "SHIPPING_FIRST" })).toBe(true);
    expect(staffChannelJudged()).toBe(true);
    // a stale caller still holding the removed field changes nothing
    expect(
      staffChannelJudged({ enabled: false, addressPrecedence: "BILLING_FIRST" } as never),
    ).toBe(true);
  });

  it("the edit service never reads the switch any other way", () => {
    const src = fs.readFileSync(path.join(__dirname, "rule-edit.service.ts"), "utf8");
    expect(src).toMatch(/staffChannelJudged\(policy\)/);
    expect(src).not.toMatch(/restrictionsApply\(|\.enabled\b/);
  });

  it("the helper does not read the policy or the engine at all", () => {
    const src = fs.readFileSync(path.join(__dirname, "staff-channel.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/restrictionsApply|\.enabled\b|selling-restrictions\.core/);
  });
});

/** Cross-row pin (a): a rule moving from BUYER_PORTAL to ALL TIGHTENS now that staff are judged (it was NEUTRAL with the switch off). */
describe("a rule widened from BUYER_PORTAL to ALL (row 510)", () => {
  const base: RuleEditSettings = {
    jurisdiction: "STATE",
    states: ["CA"],
    surface: "BUYER_PORTAL",
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    effectiveTo: null,
    reason: "state law",
  };

  it("previews as TIGHTENS (not NEUTRAL) when the staff channel is judged", () => {
    const changes = ruleEditChanges(
      base,
      { ...base, surface: "ALL" },
      {
        staffEnforced: staffChannelJudged(),
      },
    );
    expect(changes).toEqual([{ field: "surface", direction: "TIGHTENS" }]);
  });

  it("and the reverse, ALL to BUYER_PORTAL, LOOSENS", () => {
    const changes = ruleEditChanges({ ...base, surface: "ALL" }, base, {
      staffEnforced: staffChannelJudged(),
    });
    expect(changes).toEqual([{ field: "surface", direction: "LOOSENS" }]);
  });
});

/** Cross-row pin (b): the shared impact copy never says staff are unaffected; it says they are warned. */
describe("ruleEditImpactCopy (row 510)", () => {
  const UNAFFECTED =
    /staff\W+(?:are\W+|is\W+|will\W+be\W+)?(?:un-?affected|not\W+affected|exempt|ignored|skipped)|unaffected|not affected|only the buyer|buyers only/i;

  it.each([1, 2, 3, 25])("count %i names the warning for staff and the block for buyers", (n) => {
    const text = ruleEditImpactCopy(n);
    expect(text).not.toMatch(UNAFFECTED);
    expect(text).toContain("Staff will be warned when they next edit, promote or invoice");
    expect(text).toMatch(/buyers can't order (?:it|them)\.$/);
    expect(text.startsWith(`${n} open order`)).toBe(true);
  });

  it("keeps the singular and plural handling", () => {
    expect(ruleEditImpactCopy(1)).toBe(
      "1 open order has products this change now restricts. Staff will be warned when they next edit, promote or invoice it; buyers can't order it.",
    );
    expect(ruleEditImpactCopy(4)).toBe(
      "4 open orders have products this change now restricts. Staff will be warned when they next edit, promote or invoice them; buyers can't order them.",
    );
  });

  it("the shared copy source says nothing about staff being unaffected anywhere in the file", () => {
    const file = path.resolve(__dirname, "../../../../packages/types/api/restrictions-admin.ts");
    const code = fs.readFileSync(file, "utf8");
    expect(code).not.toMatch(/staff unaffected|staff are unaffected|staff aren't affected/i);
  });
});
