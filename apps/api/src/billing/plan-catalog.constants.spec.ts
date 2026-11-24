import {
  PLAN_KEYS,
  LEGACY_PLAN_KEY_ALIASES,
  planKeyToEnum,
  planKeyFromEnum,
  normalizePlanKey,
  planRank,
  SELECTABLE_TENANT_PLANS,
  UnknownPlanKeyError,
  INVITE_ONLY_PLAN_KEYS,
  isInviteOnlyPlanKey,
  ALWAYS_ENFORCED_PLAN_KEYS,
  isAlwaysEnforcedPlan,
  INVITE_ONLY_PLAN_SELF_SERVE_CHECKOUT,
  inviteOnlyCheckoutAllowed,
  INVITE_ONLY_PLAN_TRIAL_DAYS,
  LITE_PLAN_DISPLAY_NAME,
} from "./plan-catalog.constants";

/**
 * B218: `planKeyToEnum()` used to fall through a bare `default: return "STARTER"` for ANY
 * key `normalizePlanKey()` could not resolve — including a genuinely off-catalog key, not
 * just the legitimate "planKey is STARTER" case. That silently under-entitled a tenant on a
 * published-but-unranked/unknown plan key by writing STARTER into `Tenant.plan` /
 * `TenantSubscription.currentPlan`. It must now THROW for an unknown key, while every KNOWN
 * key and legacy alias keeps its byte-identical mapping.
 */
describe("planKeyToEnum", () => {
  it.each([
    ["STARTER", "STARTER"],
    ["GROWTH", "TEAM"],
    ["SCALE", "BUSINESS"],
    ["ENTERPRISE", "ENTERPRISE"],
  ] as const)("maps current key %s → enum %s (byte-identical, table-driven)", (planKey, want) => {
    expect(planKeyToEnum(planKey)).toBe(want);
  });

  it.each(Object.entries(LEGACY_PLAN_KEY_ALIASES))(
    "maps legacy alias %s → the same enum as its current key",
    (legacyKey, currentKey) => {
      expect(planKeyToEnum(legacyKey)).toBe(planKeyToEnum(currentKey));
    },
  );

  it("every PLAN_KEYS member round-trips without throwing", () => {
    for (const key of PLAN_KEYS) {
      expect(() => planKeyToEnum(key)).not.toThrow();
    }
  });

  it("REG-B218 throws (never silently returns STARTER) for an off-catalog/unknown key", () => {
    expect(() => planKeyToEnum("PRO")).toThrow(/unrecognized plan key "PRO"/);
  });

  it("REG-B218 throws for null/undefined/empty — normalizePlanKey resolves none of them", () => {
    expect(() => planKeyToEnum(null)).toThrow(/unrecognized plan key/);
    expect(() => planKeyToEnum(undefined)).toThrow(/unrecognized plan key/);
    expect(() => planKeyToEnum("")).toThrow(/unrecognized plan key/);
  });

  it("REG-B218 throws for a prototype-pollution-style key (Object.hasOwn guard on the alias map)", () => {
    expect(() => planKeyToEnum("constructor")).toThrow(/unrecognized plan key/);
    expect(() => planKeyToEnum("__proto__")).toThrow(/unrecognized plan key/);
  });

  // CHANGE-2 (2026-09-13): the unresolvable-key failure now has a dedicated class, so a
  // caller (billing-cron.service.ts) can discriminate it with `instanceof` instead of
  // matching a message PREFIX — a reworded message used to silently stop discriminating a
  // data problem from a real infrastructure failure. The message text itself is unchanged
  // (REG-B218 tests above keep asserting it), and the error carries the offending key.
  it("REG-B218-TYPED throws UnknownPlanKeyError carrying the offending key", () => {
    expect(() => planKeyToEnum("PRO")).toThrow(UnknownPlanKeyError);
    let caught: unknown;
    try {
      planKeyToEnum("PRO");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnknownPlanKeyError);
    expect((caught as UnknownPlanKeyError).planKey).toBe("PRO");
    expect((caught as UnknownPlanKeyError).message).toMatch(/unrecognized plan key "PRO"/);
  });
});

/**
 * SA-1254 V1 + (b) 6 (P-41, the census-independent half). CORE (Essentials) and ALL_IN (Pro)
 * identity-map in both directions, and the ladder is ranked by price. PLUS is not here: it joins
 * between CORE and GROWTH only if the census is above zero (SA-1254 A1). Red on master: PLAN_KEYS
 * has 5 members there, planKeyFromEnum("CORE") reads "STARTER" (T1), and planKeyToEnum("CORE")
 * throws (T2).
 */
describe("SA-1254 V1: CORE and ALL_IN in the plan vocabulary (P-41)", () => {
  it("PLAN_KEYS is the price ladder LITE, STARTER, CORE, GROWTH, ALL_IN, SCALE, ENTERPRISE", () => {
    expect(PLAN_KEYS).toEqual([
      "LITE",
      "STARTER",
      "CORE",
      "GROWTH",
      "ALL_IN",
      "SCALE",
      "ENTERPRISE",
    ]);
  });

  it.each(["CORE", "ALL_IN"])("T1/T2: %s maps to itself in every helper", (key) => {
    expect(planKeyFromEnum(key)).toBe(key);
    expect(planKeyToEnum(key)).toBe(key);
    expect(normalizePlanKey(key)).toBe(key);
  });

  it("T3: GROWTH still writes TEAM, and TEAM still reads GROWTH", () => {
    expect(planKeyToEnum("GROWTH")).toBe("TEAM");
    expect(planKeyFromEnum("TEAM")).toBe("GROWTH");
  });

  it("every PLAN_KEYS member round-trips through the enum and back to itself", () => {
    for (const key of PLAN_KEYS) {
      expect(`${key} -> ${planKeyFromEnum(planKeyToEnum(key))}`).toBe(`${key} -> ${key}`);
    }
  });

  it("every selectable DTO value reads back as a PLAN_KEYS member that writes without throwing", () => {
    expect(SELECTABLE_TENANT_PLANS).toEqual(expect.arrayContaining(["CORE", "ALL_IN"]));
    for (const value of SELECTABLE_TENANT_PLANS) {
      const key = planKeyFromEnum(value);
      expect(PLAN_KEYS).toContain(key);
      expect(() => planKeyToEnum(key)).not.toThrow();
    }
  });

  it("T4: the ranks follow the price ladder", () => {
    const order = ["LITE", "STARTER", "CORE", "GROWTH", "ALL_IN", "SCALE", "ENTERPRISE"];
    for (let i = 1; i < order.length; i += 1) {
      expect(`${order[i - 1]} < ${order[i]}: ${planRank(order[i - 1]) < planRank(order[i])}`).toBe(
        `${order[i - 1]} < ${order[i]}: true`,
      );
    }
    expect(planRank("CORE")).toBeGreaterThanOrEqual(0);
    expect(planRank("ALL_IN")).toBeGreaterThanOrEqual(0);
  });

  it("no PLUS yet: it waits for the census (SA-1254 A1)", () => {
    expect(normalizePlanKey("PLUS")).toBeNull();
    expect(() => planKeyToEnum("PLUS")).toThrow(UnknownPlanKeyError);
  });
});

/**
 * T1 (WP1, lite-L2 plan): LITE plan-vocabulary coverage. `PLAN_KEYS` would have 4 members and
 * `planKeyToEnum("LITE")` would throw `UnknownPlanKeyError` until LITE lands — this suite is
 * RED against today's `plan-catalog.constants.ts`.
 */
describe("LITE plan vocabulary (WP1 T1)", () => {
  // Superseded by SA-1254 (b) 6 (P-41): the order pin is the 7-member ladder in the suite below.
  it("PLAN_KEYS keeps LITE first (order pin, not indices)", () => {
    expect(PLAN_KEYS[0]).toBe("LITE");
  });

  it("planRank ranks LITE below every existing plan and preserves their relative order", () => {
    expect(planRank("LITE")).toBe(0);
    expect(planRank("STARTER")).toBeLessThan(planRank("GROWTH"));
    expect(planRank("GROWTH")).toBeLessThan(planRank("SCALE"));
    expect(planRank("SCALE")).toBeLessThan(planRank("ENTERPRISE"));
  });

  it("planKeyFromEnum/planKeyToEnum/normalizePlanKey round-trip LITE identity", () => {
    expect(planKeyFromEnum("LITE")).toBe("LITE");
    expect(planKeyToEnum("LITE")).toBe("LITE");
    expect(normalizePlanKey("LITE")).toBe("LITE");
  });

  it("SELECTABLE_TENANT_PLANS includes LITE", () => {
    expect(SELECTABLE_TENANT_PLANS).toContain("LITE");
  });

  it("the existing B218 table stays byte-identical (GROWTH→TEAM, SCALE→BUSINESS)", () => {
    expect(planKeyToEnum("GROWTH")).toBe("TEAM");
    expect(planKeyToEnum("SCALE")).toBe("BUSINESS");
  });

  it("INVITE_ONLY_PLAN_KEYS deep-equals [LITE] and isInviteOnlyPlanKey gates on membership", () => {
    expect(INVITE_ONLY_PLAN_KEYS).toEqual(["LITE"]);
    expect(isInviteOnlyPlanKey("LITE")).toBe(true);
    expect(isInviteOnlyPlanKey("STARTER")).toBe(false);
    expect(isInviteOnlyPlanKey(null)).toBe(false);
    expect(isInviteOnlyPlanKey(undefined)).toBe(false);
  });

  it("ALWAYS_ENFORCED_PLAN_KEYS is a subset of INVITE_ONLY_PLAN_KEYS (R3a.7)", () => {
    for (const key of ALWAYS_ENFORCED_PLAN_KEYS) {
      expect(INVITE_ONLY_PLAN_KEYS as readonly string[]).toContain(key);
    }
    expect(isAlwaysEnforcedPlan("LITE")).toBe(true);
    expect(isAlwaysEnforcedPlan("STARTER")).toBe(false);
  });

  it("LITE_PLAN_DISPLAY_NAME is 'Lite' and INVITE_ONLY_PLAN_TRIAL_DAYS is 0", () => {
    expect(LITE_PLAN_DISPLAY_NAME).toBe("Lite");
    expect(INVITE_ONLY_PLAN_TRIAL_DAYS).toBe(0);
  });

  it("inviteOnlyCheckoutAllowed gates self-serve checkout on the lever, only for invite-only plans", () => {
    expect(inviteOnlyCheckoutAllowed("LITE", false)).toBe(false);
    expect(inviteOnlyCheckoutAllowed("LITE", true)).toBe(true);
    expect(inviteOnlyCheckoutAllowed("STARTER", false)).toBe(true);
    expect(inviteOnlyCheckoutAllowed("STARTER", true)).toBe(true);
  });

  it("INVITE_ONLY_PLAN_SELF_SERVE_CHECKOUT default lever is true (Q1)", () => {
    expect(INVITE_ONLY_PLAN_SELF_SERVE_CHECKOUT).toBe(true);
  });
});
