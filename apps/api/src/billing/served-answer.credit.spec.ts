import { FEATURE_REGISTRY, type FeatureDef } from "./feature-registry";
import { servedAnswer } from "./served-answer";
import { creditLimitCheckApplies } from "../orders/credit-limit-guard";

/**
 * SA-1099 A-1 (rows SV-1 to SV-5): the credit check's served answer has ONE home, `servedAnswer`.
 *
 * The guard runs the check for everyone unless `PLAN_FLAG_ENFORCEMENT` is exactly "on", and ignores
 * overrides while it does (`creditLimitCheckApplies`). Only with the switch "on" does the tenant's
 * `entitlements.hasFlag` decide: override first, then the plan flag. A failed plan resolve runs the
 * check, as `isCreditLimitCheckEnabled`'s catch does.
 *
 * The oracle for the parity table is NOT `servedAnswer`: it is `creditLimitCheckApplies` over a
 * hand-written model of `EntitlementsService.hasFlag`'s order.
 */
const CREDIT = "flag.credit_limits";
const def = (key: string): FeatureDef => FEATURE_REGISTRY.find((f) => f.key === key)!;
type Effect = "GRANT" | "DENY";

const envOf = (value?: string): NodeJS.ProcessEnv =>
  (value === undefined ? {} : { PLAN_FLAG_ENFORCEMENT: value }) as NodeJS.ProcessEnv;

function served(opts: {
  sw?: string;
  has?: boolean;
  override?: Effect;
  ent?: "resolved" | "failed";
  planKey?: string;
}): boolean {
  const failed = opts.ent === "failed";
  return servedAnswer(
    def(CREDIT),
    {
      ent: failed ? null : { planKey: opts.planKey ?? "STARTER", flags: opts.has ? [CREDIT] : [] },
      overrides: new Map(opts.override ? [[CREDIT, opts.override]] : []),
      activeAddonKeys: new Set(),
      isAlwaysEnforced: opts.planKey === "LITE",
    },
    envOf(opts.sw),
  );
}

describe("SV-1, SV-2: switch not 'on' -> the credit check runs, whatever the plan or an override says", () => {
  it("SV-1: switch unset, plan lacks the flag, no override -> true", () => {
    expect(served({ sw: undefined, has: false })).toBe(true);
  });

  it("SV-2: switch unset, DENY override -> true (the guard ignores it)", () => {
    expect(served({ sw: undefined, has: false, override: "DENY" })).toBe(true);
    expect(served({ sw: undefined, has: true, override: "DENY" })).toBe(true);
  });

  it("a Lite plan gets no always-enforced exception on this row (SA-1099 section 1)", () => {
    expect(served({ sw: undefined, has: false, planKey: "LITE" })).toBe(true);
  });
});

describe("SV-3: switch 'on' -> the tenant's own flag decides, override first (guard rows)", () => {
  it.each([
    ["plan lacks the flag", { has: false }, false],
    ["plan has the flag", { has: true }, true],
    ["GRANT over a plan that lacks it", { has: false, override: "GRANT" as Effect }, true],
    ["DENY over a plan that has it", { has: true, override: "DENY" as Effect }, false],
  ])("%s", (_label, facts, expected) => {
    expect(served({ sw: "on", ...facts })).toBe(expected);
  });
});

describe("SV-4: the plan could not be resolved (ent === null)", () => {
  it("switch unset -> true", () => {
    expect(served({ sw: undefined, ent: "failed" })).toBe(true);
  });

  it("switch 'on', no override -> true (the money guard stays on)", () => {
    expect(served({ sw: "on", ent: "failed" })).toBe(true);
  });

  it("switch 'on', DENY override -> false (hasFlag reads the override before the plan)", () => {
    expect(served({ sw: "on", ent: "failed", override: "DENY" })).toBe(false);
  });

  it("switch 'on', GRANT override -> true", () => {
    expect(served({ sw: "on", ent: "failed", override: "GRANT" })).toBe(true);
  });
});

describe("SV-5: the parity table, switch x override x plan flag (24 cases)", () => {
  const switches: Array<[string, string | undefined]> = [
    ["unset", undefined],
    ["'off'", "off"],
    ["'ON' (not exactly 'on')", "ON"],
    ["'on'", "on"],
  ];
  const overrides: Array<Effect | undefined> = [undefined, "GRANT", "DENY"];
  const plans: Array<[string, boolean]> = [
    ["plan has the flag", true],
    ["plan lacks the flag", false],
  ];
  const cases = switches.flatMap(([swLabel, sw]) =>
    overrides.flatMap((override) =>
      plans.map(([planLabel, has]) => ({
        name: `switch ${swLabel}, override ${override ?? "none"}, ${planLabel}`,
        sw,
        override,
        has,
      })),
    ),
  );

  it("is 24 cases", () => {
    expect(cases).toHaveLength(24);
  });

  it.each(cases)("$name", ({ sw, override, has }) => {
    // EntitlementsService.hasFlag's order: override first, then the plan's flag list
    const hasFlagModel = override === "GRANT" ? true : override === "DENY" ? false : has;
    expect(served({ sw, has, override })).toBe(creditLimitCheckApplies(sw, hasFlagModel));
  });
});

describe("the rule is keyed on the gate predicate, never on the literal key", () => {
  it("every registry row that carries the env-switched service gate gets the credit rule", () => {
    const keyed = FEATURE_REGISTRY.filter((f) => f.gate.via === "service" && f.gate.envSwitched);
    expect(keyed.map((f) => f.key)).toContain(CREDIT);
    for (const feature of keyed) {
      const answer = servedAnswer(
        feature,
        {
          ent: { planKey: "STARTER", flags: [] },
          overrides: new Map([[feature.key, "DENY" as Effect]]),
          activeAddonKeys: new Set(),
          isAlwaysEnforced: false,
        },
        envOf(undefined),
      );
      expect(answer).toBe(true);
    }
  });
});
