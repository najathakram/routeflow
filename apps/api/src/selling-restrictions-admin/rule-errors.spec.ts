import { ruleEndUseLift, ruleImpactTooLarge } from "./rule-errors";

describe("rule edit coded errors", () => {
  it("ending a rule now is a coded 400 that points at lifting", () => {
    const e = ruleEndUseLift();
    expect(e.getStatus()).toBe(400);
    expect(e.getResponse()).toMatchObject({
      code: "RULE_END_USE_LIFT",
      message: "To end this rule now, lift it.",
    });
  });

  it("an impact too large to count is a coded 409 that names the cap", () => {
    const e = ruleImpactTooLarge(2000);
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toMatchObject({ code: "RULE_IMPACT_TOO_LARGE", max: 2000 });
  });
});
