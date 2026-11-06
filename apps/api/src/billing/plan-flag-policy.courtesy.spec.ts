import { decideAddonAccess } from "./addon-access";
import { FEATURE_REGISTRY, addonGateState, gateVia } from "./feature-registry";
import { DARK_PLAN_FLAGS, allowsFlag, isCourtesyServed } from "./plan-flag-policy";

/**
 * SA-1100 §3 — the ONE courtesy predicate. Worked by hand from the three clauses (the oracle):
 *  1. the credit check: courtesy while the switch is not exactly "on", with no always-enforced exception;
 *  2. an add-on keyed gate: exactly `decideAddonAccess`'s "dark" outcome;
 *  3. a plan-flag keyed gate: a dark flag on a non-always-enforced plan that lacks the flag.
 */
type Effect = "GRANT" | "DENY";
const facts = (
  keys: string[],
  over: {
    planKey?: string;
    planFlags?: string[];
    overrides?: Record<string, Effect>;
    held?: string[];
  } = {},
) => ({
  keys,
  planKey: over.planKey ?? "STARTER",
  planFlags: over.planFlags ?? [],
  overrides: new Map(Object.entries(over.overrides ?? {})) as Map<string, Effect>,
  held: new Set(over.held ?? []),
});
const OFF = {} as NodeJS.ProcessEnv;
const ON = { PLAN_FLAG_ENFORCEMENT: "on" } as NodeJS.ProcessEnv;

describe("isCourtesyServed: plan-flag keyed gates (clause 3)", () => {
  it("a dark flag on a plan that lacks it is courtesy while the switch is off", () => {
    expect(isCourtesyServed(facts(["flag.reports"]), OFF)).toBe(true);
    expect(isCourtesyServed(facts(["flag.analytics"]), OFF)).toBe(true);
  });

  it("the plan carrying the flag is not courtesy (the plan is the source)", () => {
    expect(isCourtesyServed(facts(["flag.reports"], { planFlags: ["flag.reports"] }), OFF)).toBe(
      false,
    );
  });

  it("an always-enforced plan (Lite) never gets the courtesy allow", () => {
    expect(isCourtesyServed(facts(["flag.reports"], { planKey: "LITE" }), OFF)).toBe(false);
  });

  it("an active override (GRANT or DENY) is absolute, never courtesy", () => {
    expect(
      isCourtesyServed(facts(["flag.reports"], { overrides: { "flag.reports": "GRANT" } }), OFF),
    ).toBe(false);
    expect(
      isCourtesyServed(facts(["flag.reports"], { overrides: { "flag.reports": "DENY" } }), OFF),
    ).toBe(false);
  });

  it("switch on: a dark flag is enforced; the five pre-pin flags stay courtesy", () => {
    expect(isCourtesyServed(facts(["flag.reports"]), ON)).toBe(false);
    expect(isCourtesyServed(facts(["flag.estimates"]), ON)).toBe(true);
  });

  it("a flag that was never dark (flag.msrp) is never courtesy", () => {
    expect(isCourtesyServed(facts(["flag.msrp"]), OFF)).toBe(false);
  });
});

describe("isCourtesyServed: the credit check (clause 1, SA-1099 §1)", () => {
  it("switch unset, 'off' or any non-'on' value: courtesy, flag held or not", () => {
    expect(isCourtesyServed(facts(["flag.credit_limits"]), OFF)).toBe(true);
    expect(
      isCourtesyServed(facts(["flag.credit_limits"]), { PLAN_FLAG_ENFORCEMENT: "off" } as never),
    ).toBe(true);
    expect(
      isCourtesyServed(facts(["flag.credit_limits"]), { PLAN_FLAG_ENFORCEMENT: "ON" } as never),
    ).toBe(true);
    expect(
      isCourtesyServed(facts(["flag.credit_limits"], { planFlags: ["flag.credit_limits"] }), OFF),
    ).toBe(true);
  });

  it("no always-enforced exception: Lite is courtesy too while the switch is off", () => {
    expect(isCourtesyServed(facts(["flag.credit_limits"], { planKey: "LITE" }), OFF)).toBe(true);
  });

  it("switch exactly 'on': the flag decides, so it is not courtesy", () => {
    expect(isCourtesyServed(facts(["flag.credit_limits"]), ON)).toBe(false);
  });

  it("the guard ignores overrides while the switch is not on, so a DENY is still courtesy", () => {
    expect(
      isCourtesyServed(
        facts(["flag.credit_limits"], { overrides: { "flag.credit_limits": "DENY" } }),
        OFF,
      ),
    ).toBe(true);
  });
});

describe("isCourtesyServed: add-on keyed gates (clause 2)", () => {
  it("a dark add-on key nobody holds is courtesy (ocr is dark today)", () => {
    expect(addonGateState("ocr")).toBe("dark");
    expect(isCourtesyServed(facts(["ocr"]), OFF)).toBe(true);
  });

  it("an enforced add-on key (tobacco_dealer) is never courtesy", () => {
    expect(addonGateState("tobacco_dealer")).toBe("enforced");
    expect(isCourtesyServed(facts(["tobacco_dealer"]), OFF)).toBe(false);
  });

  it("held, GRANT-ed, DENY-ed or on Lite: not courtesy", () => {
    expect(isCourtesyServed(facts(["ocr"], { held: ["ocr"] }), OFF)).toBe(false);
    expect(isCourtesyServed(facts(["ocr"], { overrides: { ocr: "GRANT" } }), OFF)).toBe(false);
    expect(isCourtesyServed(facts(["ocr"], { overrides: { ocr: "DENY" } }), OFF)).toBe(false);
    expect(isCourtesyServed(facts(["ocr"], { planKey: "LITE" }), OFF)).toBe(false);
  });

  it("the switch does not move an add-on gate (its state is per-key, not env-switched)", () => {
    expect(isCourtesyServed(facts(["ocr"]), ON)).toBe(true);
  });
});

/**
 * Class pin: for every add-on keyed registry key and for any-of sets, the predicate agrees with
 * `decideAddonAccess`'s "dark" outcome across plan x held x override. Adding a fourth clause to one
 * and not the other turns this red.
 */
describe("isCourtesyServed === decideAddonAccess 'dark' outcome", () => {
  const addonKeys = FEATURE_REGISTRY.filter((f) =>
    ["RequireAddon", "guard"].includes(f.gate.via),
  ).map((f) => f.key);
  const sets: string[][] = [
    ...addonKeys.map((k) => [k]),
    ["ocr", "crm_gohighlevel"],
    ["ocr", "tobacco_dealer"],
    ["recurring_routes", "order_delivery", "developer_mode"],
    ["order_delivery", "developer_mode"],
  ];

  it("every add-on keyed registry row is covered by the table", () => {
    expect(addonKeys.length).toBeGreaterThan(3);
    for (const k of addonKeys) expect(["RequireAddon", "guard"]).toContain(gateVia(k));
  });

  it.each(sets.map((s) => [s.join("|"), s] as const))("set %s", async (_name, keys) => {
    const overrideChoices: (Effect | undefined)[] = [undefined, "GRANT", "DENY"];
    for (const planKey of ["STARTER", "LITE"]) {
      for (const heldFirst of [false, true]) {
        for (const o of overrideChoices) {
          const overrides = o ? { [keys[0]]: o } : {};
          const held = heldFirst ? [keys[0]] : [];
          const f = facts(keys, { planKey, overrides, held });
          const decision = await decideAddonAccess(
            {
              addonService: { getActiveAddons: async () => [...held] },
              entitlements: { isAlwaysEnforcedTenant: async () => planKey === "LITE" },
              featureOverrides: {
                getMany: async () => new Map(Object.entries(overrides)) as Map<string, Effect>,
              },
            } as never,
            "t1",
            [...keys],
          );
          const label = `${keys.join("|")} plan=${planKey} held=${heldFirst} override=${o}`;
          expect({ label, courtesy: isCourtesyServed(f, OFF) }).toEqual({
            label,
            courtesy: decision.outcome === "dark",
          });
        }
      }
    }
  });
});

/**
 * Class pin (reader A note 3): the flag clause against allowsFlag, the rule behind
 * computeOldPathAll, over every DARK_PLAN_FLAGS entry x switch x plan x flag held. With no
 * override, a served answer comes from the courtesy allow exactly when allowsFlag says yes
 * although the plan lacks the flag. Red if the two rules diverge.
 */
describe("isCourtesyServed flag clause === allowsFlag courtesy over every DARK_PLAN_FLAGS entry", () => {
  const envs: [string, NodeJS.ProcessEnv][] = [
    ["switch unset", {} as NodeJS.ProcessEnv],
    ["switch off", { PLAN_FLAG_ENFORCEMENT: "off" } as NodeJS.ProcessEnv],
    ["switch on", { PLAN_FLAG_ENFORCEMENT: "on" } as NodeJS.ProcessEnv],
  ];

  it.each([...DARK_PLAN_FLAGS].sort())("%s", (key) => {
    expect(gateVia(key)).toBe("RequirePlanFlag");
    for (const [envName, env] of envs) {
      for (const planKey of ["STARTER", "GROWTH", "LITE"]) {
        for (const carries of [false, true]) {
          const planFlags = carries ? [key] : [];
          const label = `${key} ${envName} plan=${planKey} carries=${carries}`;
          const courtesyAllow = allowsFlag({ planKey, flags: planFlags }, key, env) && !carries;
          expect({
            label,
            courtesy: isCourtesyServed(facts([key], { planKey, planFlags }), env),
          }).toEqual({
            label,
            courtesy: courtesyAllow,
          });
        }
      }
    }
  });
});
