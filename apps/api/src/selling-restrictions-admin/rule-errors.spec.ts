import { ruleEndUseLift } from "./rule-errors";

describe("rule edit coded errors", () => {
  it("ending a rule now is a coded 400 that points at lifting", () => {
    const e = ruleEndUseLift();
    expect(e.getStatus()).toBe(400);
    expect(e.getResponse()).toMatchObject({
      code: "RULE_END_USE_LIFT",
      message: "To end this rule now, lift it.",
    });
  });
});
