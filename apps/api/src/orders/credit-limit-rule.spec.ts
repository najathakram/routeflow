import { creditLimitCheckApplies } from "./credit-limit-guard";

/**
 * SA-1099 §2 — the ONE pure rule behind `isCreditLimitCheckEnabled`: the credit check runs for
 * everyone unless the PLAN_FLAG_ENFORCEMENT switch is "on"; only then does the plan flag decide.
 * `EntitlementAuthority.computeOldPath` reads `allowsFlag` for `flag.credit_limits` and says false
 * on a Starter, which is the wrong value the sweep's `old` column must not inherit.
 */
describe("creditLimitCheckApplies (pure rule)", () => {
  it("Starter (no flag), switch unset: the check runs (computeOldPath's allowsFlag says false)", () => {
    expect(creditLimitCheckApplies(undefined, false)).toBe(true);
  });

  it("switch 'off' or any non-'on' value: the check runs for a tenant without the flag", () => {
    expect(creditLimitCheckApplies("off", false)).toBe(true);
    expect(creditLimitCheckApplies("ON", false)).toBe(true);
    expect(creditLimitCheckApplies("", false)).toBe(true);
  });

  it("switch 'on' and no plan flag: the check does not run", () => {
    expect(creditLimitCheckApplies("on", false)).toBe(false);
  });

  it("switch 'on' and the flag held: the check runs", () => {
    expect(creditLimitCheckApplies("on", true)).toBe(true);
  });

  it("switch unset and the flag held: the check runs", () => {
    expect(creditLimitCheckApplies(undefined, true)).toBe(true);
  });
});
