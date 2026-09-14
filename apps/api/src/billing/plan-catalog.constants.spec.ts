import {
  PLAN_KEYS,
  LEGACY_PLAN_KEY_ALIASES,
  planKeyToEnum,
  UnknownPlanKeyError,
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
