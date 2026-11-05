import { FEATURE_REGISTRY, type FeatureDef } from "./feature-registry";
import { servedAnswer } from "./served-answer";
import { creditLimitCheckApplies } from "../orders/credit-limit-guard";
import { MULTI_KEY_ADDON_SETS } from "./entitlement-sweep.service";
import { decideAddonAccess } from "./addon-access";
import { isCourtesyServed } from "./plan-flag-policy";
import { isDefaultGrantedAddon } from "./feature-registry";
import { resolveOneKey, type ResolvedKey } from "./feature-resolver.service";

/**
 * FG-1 WP2, T2 (R2): "`effective` equals today's served answer on every gated key, every fixture".
 *
 * The oracle is the OLD path, never the evaluator under test:
 *   - `servedAnswer` is the one pure function behind `EntitlementAuthority.computeOldPathAll`;
 *   - the credit row is the guard's own rule, `creditLimitCheckApplies(switch, hasFlag)` (SA-1099 section 2),
 *     because `servedAnswer` does not model it;
 *   - the two multi-key `@RequireAddon` sets are `decideAddonAccess` (build-plan E35).
 *
 * Part A is the characterization: a hand-worked table of what the old path serves, green on the old code and
 * on the new. Part B is the differential: every gated key x plan x row x override x switch.
 */
type Effect = "GRANT" | "DENY";
const SWITCH = "PLAN_FLAG_ENFORCEMENT";
const savedSwitch = process.env[SWITCH];
afterEach(() => {
  if (savedSwitch === undefined) delete process.env[SWITCH];
  else process.env[SWITCH] = savedSwitch;
});

const def = (key: string): FeatureDef => FEATURE_REGISTRY.find((f) => f.key === key)!;
const ALWAYS_ENFORCED = new Set(["LITE"]);

interface Facts {
  planKey: string;
  planFlags: string[];
  held: string[];
  overrides: Record<string, Effect>;
}

/** The old path's answer for one key, from the same facts. */
function oldAnswer(feature: FeatureDef, f: Facts, env: NodeJS.ProcessEnv): boolean {
  const overrides = new Map(Object.entries(f.overrides)) as Map<string, Effect>;
  if (feature.gate.via === "service" && feature.gate.envSwitched) {
    // the guard asks entitlements.hasFlag, which reads the override first
    const o = overrides.get(feature.key);
    const hasFlag = o === "GRANT" ? true : o === "DENY" ? false : f.planFlags.includes(feature.key);
    return creditLimitCheckApplies(env[SWITCH], hasFlag);
  }
  return servedAnswer(
    feature,
    {
      ent: { planKey: f.planKey, flags: f.planFlags },
      overrides,
      activeAddonKeys: new Set(f.held),
      isAlwaysEnforced: ALWAYS_ENFORCED.has(f.planKey),
    },
    env,
  );
}

/**
 * The evaluator's answer for one key. The context is built the way `FeatureResolverService.compute` builds it;
 * the WP2 fields (`courtesy`, `billed`) are passed untyped so this spec compiles against the old resolver and
 * fails there on the wrong VALUE (old `effective` ignores courtesy), not on a type error.
 */
type Evaluated = ResolvedKey & { strict?: boolean };
const evaluate = resolveOneKey as unknown as (
  f: FeatureDef,
  ctx: Record<string, unknown>,
) => Evaluated;

function newAnswer(feature: FeatureDef, f: Facts, env: NodeJS.ProcessEnv): Evaluated {
  const overrides = new Map(Object.entries(f.overrides)) as Map<string, Effect>;
  const activeAddonSet = new Set(f.held);
  // held = rows + default grants, computed here from the registry (not from the code under test)
  const held = new Set(activeAddonSet);
  for (const k of FEATURE_REGISTRY) {
    if (isDefaultGrantedAddon(k, activeAddonSet, f.planFlags, overrides)) held.add(k.key);
  }
  return evaluate(feature, {
    overrides,
    activeAddonSet,
    planFeatureFlags: new Set(f.planFlags),
    entFlags: f.planFlags,
    activeSkuSet: new Set(),
    courtesy: (d: FeatureDef) =>
      isCourtesyServed(
        { keys: [d.key], planKey: f.planKey, planFlags: f.planFlags, overrides, held },
        env,
      ),
    billed: new Set<string>(),
  });
}

const facts = (over: Partial<Facts> = {}): Facts => ({
  planKey: "STARTER",
  planFlags: [],
  held: [],
  overrides: {},
  ...over,
});

describe("T2 part A: what today's guards serve (characterization, hand-worked)", () => {
  const OFF = {} as NodeJS.ProcessEnv;
  const ON = { [SWITCH]: "on" } as NodeJS.ProcessEnv;
  const cases: Array<[string, string, Facts, NodeJS.ProcessEnv, boolean]> = [
    ["dark flag, plan lacks it, switch off: courtesy serves", "flag.reports", facts(), OFF, true],
    ["dark flag, plan lacks it, switch on: enforced", "flag.reports", facts(), ON, false],
    ["dark flag on Lite: never courtesy", "flag.reports", facts({ planKey: "LITE" }), OFF, false],
    ["dark flag, plan holds it", "flag.reports", facts({ planFlags: ["flag.reports"] }), ON, true],
    [
      "dark flag, DENY override beats courtesy",
      "flag.reports",
      facts({ overrides: { "flag.reports": "DENY" } }),
      OFF,
      false,
    ],
    [
      "dark flag, GRANT override serves",
      "flag.reports",
      facts({ overrides: { "flag.reports": "GRANT" } }),
      ON,
      true,
    ],
    ["flag that was never dark, plan lacks it", "flag.msrp", facts(), OFF, false],
    ["dark add-on key, no row, not Lite: courtesy serves", "ocr", facts(), OFF, true],
    ["dark add-on key on Lite", "ocr", facts({ planKey: "LITE" }), OFF, false],
    ["dark add-on key, DENY override", "ocr", facts({ overrides: { ocr: "DENY" } }), OFF, false],
    ["enforced add-on key, no row", "tobacco_dealer", facts(), OFF, false],
    [
      "enforced add-on key, row held",
      "tobacco_dealer",
      facts({ held: ["tobacco_dealer"] }),
      OFF,
      true,
    ],
    [
      "enforced add-on key, held but DENY",
      "tobacco_dealer",
      facts({ held: ["tobacco_dealer"], overrides: { tobacco_dealer: "DENY" } }),
      OFF,
      false,
    ],
    [
      "credit check, switch off, plan lacks the flag: the check runs",
      "flag.credit_limits",
      facts(),
      OFF,
      true,
    ],
    [
      "credit check, switch off, DENY override: the guard ignores it",
      "flag.credit_limits",
      facts({ overrides: { "flag.credit_limits": "DENY" } }),
      OFF,
      true,
    ],
    [
      "credit check, switch on, plan lacks the flag: skipped",
      "flag.credit_limits",
      facts(),
      ON,
      false,
    ],
    [
      "credit check, switch on, plan holds the flag",
      "flag.credit_limits",
      facts({ planFlags: ["flag.credit_limits"] }),
      ON,
      true,
    ],
  ];
  it.each(cases)("%s", (_name, key, f, env, expected) => {
    expect(oldAnswer(def(key), f, env)).toBe(expected);
  });
});

describe("T2 part B: effective equals the old path on every gated key (R2)", () => {
  const gated = FEATURE_REGISTRY.filter((f) => f.gate.via !== "none");
  const plans = ["LITE", "STARTER", "GROWTH"];
  const envs: Array<[string, NodeJS.ProcessEnv]> = [
    ["switch off", {} as NodeJS.ProcessEnv],
    ["switch on", { [SWITCH]: "on" } as NodeJS.ProcessEnv],
  ];

  it("scans a real registry (guards a vacuous matrix)", () => {
    expect(gated.length).toBeGreaterThan(25);
  });

  it.each(envs)("%s: every key x plan x flag x row x override agrees", (_label, env) => {
    if (env[SWITCH]) process.env[SWITCH] = env[SWITCH];
    else delete process.env[SWITCH];
    const bad: string[] = [];
    let compared = 0;
    for (const feature of gated) {
      for (const planKey of plans) {
        for (const planFlags of [[], [feature.key]]) {
          for (const held of [[], [feature.key]]) {
            for (const effect of [undefined, "GRANT", "DENY"] as const) {
              const f: Facts = {
                planKey,
                planFlags,
                held,
                overrides: effect ? { [feature.key]: effect } : {},
              };
              const want = oldAnswer(feature, f, process.env);
              const got = newAnswer(feature, f, process.env);
              compared++;
              if (got.effective !== want) {
                bad.push(
                  `${feature.key} plan=${planKey} flag=${planFlags.length} row=${held.length} override=${effect ?? "-"}: old ${want}, effective ${got.effective}`,
                );
              }
              // strict never exceeds effective: courtesy only ever ADDS to what is served
              if (got.strict && !got.effective)
                bad.push(`${feature.key}: strict true but effective false`);
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
    expect(bad).toEqual([]);
  });

  it("the two multi-key add-on sets agree with decideAddonAccess (E35)", async () => {
    delete process.env[SWITCH];
    const bad: string[] = [];
    for (const setKeys of MULTI_KEY_ADDON_SETS) {
      for (const planKey of plans) {
        for (const held of [[], [setKeys[0]], [setKeys[setKeys.length - 1]]]) {
          for (const effect of [undefined, "GRANT", "DENY"] as const) {
            const overrides = new Map<string, Effect>(effect ? [[setKeys[0], effect]] : []);
            const decision = await decideAddonAccess(
              {
                addonService: { getActiveAddons: async () => held } as never,
                entitlements: { isAlwaysEnforcedTenant: async () => ALWAYS_ENFORCED.has(planKey) },
                featureOverrides: { getMany: async () => overrides } as never,
              },
              "t1",
              [...setKeys],
            );
            const f: Facts = {
              planKey,
              planFlags: [],
              held,
              overrides: effect ? { [setKeys[0]]: effect } : {},
            };
            const effective = setKeys.some((k) => newAnswer(def(k), f, process.env).effective);
            if (effective !== (decision.outcome !== "denied")) {
              bad.push(
                `${setKeys.join("|")} plan=${planKey} held=${held} override=${effect ?? "-"}`,
              );
            }
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
