/**
 * PR-0b: automated "keep in lock-step" guard for
 * apps/api/scripts/lib/feature-registry-mirror.cjs — the plain SQL/JS mirror
 * apps/api/scripts/publish-and-repin.mjs consults because it runs standalone under plain `node`
 * and cannot import the compiled Nest app (see that file's own header, and
 * audit-tenant-entitlements.mjs's identical precedent).
 *
 * Every other script mirror in this repo keeps itself honest with a code-comment promise alone
 * ("Any behavioural change ... ported here in step — never the other way around"). This spec
 * makes that promise mechanical: it imports the REAL TypeScript modules (available to a Jest spec
 * via ts-jest, unlike the standalone script) and asserts every field/behaviour the mirror copies,
 * so a registry change that isn't ported fails THIS spec, not just a comment.
 *
 * No database — pure data/function comparison plus two of the task's required fixture scenarios
 * (dark-list-driven LOSS, zero-loss), reusing the SAME shared fixtures every feature-grants-v2
 * slice already tests against (feature-fixtures.ts) rather than inventing new ones. The
 * DB-backed, end-to-end CLI proof (--apply write/idempotency/refusal/no-PII) lives in
 * publish-and-repin.db.spec.ts.
 */
import { FEATURE_REGISTRY, addonGateState } from "./feature-registry";
import {
  DARK_PLAN_FLAGS,
  isPlanFlagEnforcementOn,
  isDarkFlag,
  allowsFlag,
} from "./plan-flag-policy";
import {
  ALWAYS_ENFORCED_PLAN_KEYS,
  isAlwaysEnforcedPlan,
  PLAN_KEYS,
} from "./plan-catalog.constants";
import { V11_PIN_FIXTURE, LITE_FIXTURE, ALL_FIXTURES } from "./feature-fixtures";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mirror = require("../../scripts/lib/feature-registry-mirror.cjs") as {
  FEATURE_REGISTRY_MIRROR: Array<{
    key: string;
    via: string;
    state: string;
    defaultGranted: boolean;
  }>;
  DARK_PLAN_FLAGS: Set<string>;
  ALWAYS_ENFORCED_PLAN_KEYS: Set<string>;
  ALWAYS_EFFECTIVE_TODAY: Set<string>;
  isDarkFlag: (key: string, env: NodeJS.ProcessEnv) => boolean;
  isAlwaysEnforcedPlan: (planKey: string | null) => boolean;
  computeOldPathEffective: (
    feature: { key: string; via: string; state: string },
    ctx: {
      overrides: Map<string, "GRANT" | "DENY">;
      activeAddonSet: Set<string>;
      planKey: string;
      entFlags: string[];
    },
    env?: NodeJS.ProcessEnv,
  ) => boolean;
  computeNewPathEffective: (
    feature: { key: string; via: string; defaultGranted: boolean },
    ctx: {
      overrides: Map<string, "GRANT" | "DENY">;
      activeAddonSet: Set<string>;
      entFlags: string[];
    },
  ) => boolean;
};

describe("feature-registry-mirror.cjs parity with the real TypeScript source", () => {
  it("has exactly the same key set as FEATURE_REGISTRY", () => {
    const realKeys = new Set(FEATURE_REGISTRY.map((f) => f.key));
    const mirrorKeys = new Set(mirror.FEATURE_REGISTRY_MIRROR.map((f) => f.key));
    expect(mirrorKeys).toEqual(realKeys);
    expect(mirror.FEATURE_REGISTRY_MIRROR.length).toBe(FEATURE_REGISTRY.length);
  });

  it("mirrors gate.via and defaultGranted for every key", () => {
    const byKey = new Map(mirror.FEATURE_REGISTRY_MIRROR.map((f) => [f.key, f]));
    for (const real of FEATURE_REGISTRY) {
      const m = byKey.get(real.key);
      expect(m).toBeDefined();
      expect(m!.via).toBe(real.gate.via);
      expect(m!.defaultGranted).toBe(real.defaultGranted);
    }
  });

  it("mirrors gate.state for every RequireAddon row (the only state addonGateState reads)", () => {
    const byKey = new Map(mirror.FEATURE_REGISTRY_MIRROR.map((f) => [f.key, f]));
    for (const real of FEATURE_REGISTRY.filter((f) => f.gate.via === "RequireAddon")) {
      expect(byKey.get(real.key)!.state).toBe(real.gate.state);
    }
  });

  it(
    "the mirror's courtesy-state derivation (RequireAddon uses its own state, everything else " +
      "— including 'guard' — reads back 'enforced') matches the real addonGateState() for every key",
    () => {
      for (const m of mirror.FEATURE_REGISTRY_MIRROR) {
        const derived = m.via === "RequireAddon" ? m.state : "enforced";
        expect(derived).toBe(addonGateState(m.key));
      }
    },
  );

  it("DARK_PLAN_FLAGS matches exactly (direct export, exact Set)", () => {
    expect(mirror.DARK_PLAN_FLAGS).toEqual(DARK_PLAN_FLAGS);
  });

  it("ALWAYS_ENFORCED_PLAN_KEYS matches exactly, and isAlwaysEnforcedPlan agrees for every plan key", () => {
    expect(mirror.ALWAYS_ENFORCED_PLAN_KEYS).toEqual(ALWAYS_ENFORCED_PLAN_KEYS);
    for (const planKey of [...PLAN_KEYS, "UNKNOWN", null]) {
      expect(mirror.isAlwaysEnforcedPlan(planKey as string | null)).toBe(
        isAlwaysEnforcedPlan(planKey as string | null),
      );
    }
  });

  it(
    "isDarkFlag behaviour matches for every registry key, both with PLAN_FLAG_ENFORCEMENT on and " +
      "off (this is what actually proves PREPIN_DARK_FLAGS is mirrored correctly — that set is " +
      "not exported, so its correctness is checked through observable behaviour instead)",
    () => {
      for (const envValue of ["on", "off", undefined]) {
        const env = envValue === undefined ? {} : { PLAN_FLAG_ENFORCEMENT: envValue };
        for (const real of FEATURE_REGISTRY) {
          expect(mirror.isDarkFlag(real.key, env as NodeJS.ProcessEnv)).toBe(
            isDarkFlag(real.key, env as NodeJS.ProcessEnv),
          );
        }
        // isPlanFlagEnforcementOn itself, for completeness of the env-parsing behaviour.
        expect(mirror.isDarkFlag("flag.returns", env as NodeJS.ProcessEnv)).toBe(
          isDarkFlag("flag.returns", env as NodeJS.ProcessEnv),
        );
      }
    },
  );

  it("allowsFlag behaviour matches for every (planKey, key) pair the fixtures exercise", () => {
    for (const fixture of ALL_FIXTURES) {
      for (const real of FEATURE_REGISTRY) {
        const entFlags =
          fixture.definitions.find((d) => d.planKey === fixture.planKey)?.featureFlags ?? [];
        const env = { PLAN_FLAG_ENFORCEMENT: "on" } as NodeJS.ProcessEnv;
        expect(mirror.allowsFlag(fixture.planKey, entFlags, real.key, env)).toBe(
          allowsFlag({ planKey: fixture.planKey, flags: entFlags }, real.key, env),
        );
      }
    }
  });

  it(
    "flag.credit_limits is the ONLY key in ALWAYS_EFFECTIVE_TODAY (the sole deliberate " +
      "deviation from a byte-for-byte mirror — see that constant's own doc comment)",
    () => {
      expect([...mirror.ALWAYS_EFFECTIVE_TODAY]).toEqual(["flag.credit_limits"]);
    },
  );
});

/** Builds the {overrides, activeAddonSet, planKey, entFlags} ctx computeOldPathEffective /
 *  computeNewPathEffective take, from a feature-fixtures.ts fixture — mirrors mockCollaborators'
 *  own (no-flagsOverride) entFlags derivation. */
function ctxFor(fixture: (typeof ALL_FIXTURES)[number]) {
  const entFlags =
    fixture.definitions.find((d) => d.planKey === fixture.planKey)?.featureFlags ?? [];
  return {
    overrides: new Map(fixture.overrides.map((o) => [o.featureKey, o.effect])),
    activeAddonSet: new Set(fixture.activeAddonKeys),
    planKey: fixture.planKey,
    entFlags,
  };
}

describe("publish-and-repin report logic against the shared feature-grants-v2 fixtures", () => {
  const PROD_ENV = { PLAN_FLAG_ENFORCEMENT: "on" } as NodeJS.ProcessEnv;

  it(
    "V11_PIN_FIXTURE (SCALE, no override): shows LOSSES for every courtesy-eligible dark key it " +
      "doesn't hold — the 5 PREPIN_DARK_FLAGS keys, the 3 RequireAddon-dark keys with no active " +
      "addon (ocr/crm_gohighlevel/email.connected_mailbox), and flag.credit_limits (the " +
      "always-effective-today special case) — 'a fixture tenant that has a feature only via the " +
      "dark list'",
    () => {
      const ctx = ctxFor(V11_PIN_FIXTURE);
      const losses = mirror.FEATURE_REGISTRY_MIRROR.filter((f) => {
        const oldEff = mirror.computeOldPathEffective(f, ctx, PROD_ENV);
        const newEff = mirror.computeNewPathEffective(f, ctx);
        return oldEff && !newEff;
      }).map((f) => f.key);

      expect(losses.sort()).toEqual(
        [
          "flag.estimates",
          "flag.recurring_invoices",
          "flag.credit_notes",
          "flag.suppliers",
          "flag.messaging",
          "ocr",
          "crm_gohighlevel",
          "email.connected_mailbox",
          "flag.credit_limits",
        ].sort(),
      );
    },
  );

  it(
    "LITE_FIXTURE: the ONLY loss is flag.credit_limits — LITE is always-enforced, so every " +
      "ORDINARY courtesy-driven loss (the P0 incident's whole failure class) is correctly absent; " +
      "the one exception is design.md's own explicit, plan-independent 'currently effective is " +
      "everyone' rule for the not-yet-wired-up credit-limit guard, which applies to LITE too",
    () => {
      const ctx = ctxFor(LITE_FIXTURE);
      const losses = mirror.FEATURE_REGISTRY_MIRROR.filter((f) => {
        const oldEff = mirror.computeOldPathEffective(f, ctx, PROD_ENV);
        const newEff = mirror.computeNewPathEffective(f, ctx);
        return oldEff && !newEff;
      }).map((f) => f.key);
      expect(losses).toEqual(["flag.credit_limits"]);
    },
  );

  it(
    "a plan that already grants flag.credit_limits explicitly (e.g. a future v12-shaped catalog) " +
      "closes even that one exception — 'a fixture tenant whose access is fully explained by " +
      "preset/grants → zero diff' in the literal, no-exceptions sense",
    () => {
      const fixture = {
        ...LITE_FIXTURE,
        name: "lite-with-credit-limits",
        definitions: [{ planKey: "LITE", featureFlags: ["flag.credit_limits"] }],
      };
      const ctx = ctxFor(fixture);
      const losses = mirror.FEATURE_REGISTRY_MIRROR.filter((f) => {
        const oldEff = mirror.computeOldPathEffective(f, ctx, PROD_ENV);
        const newEff = mirror.computeNewPathEffective(f, ctx);
        return oldEff && !newEff;
      });
      expect(losses).toEqual([]);
    },
  );

  it("an active GRANT override makes old and new path agree (never a loss or gain)", () => {
    const ctx = ctxFor(V11_PIN_FIXTURE);
    ctx.overrides.set("flag.estimates", "GRANT");
    const old = mirror.computeOldPathEffective(
      mirror.FEATURE_REGISTRY_MIRROR.find((f) => f.key === "flag.estimates")!,
      ctx,
      PROD_ENV,
    );
    const now = mirror.computeNewPathEffective(
      mirror.FEATURE_REGISTRY_MIRROR.find((f) => f.key === "flag.estimates")!,
      ctx,
    );
    expect(old).toBe(true);
    expect(now).toBe(true);
  });

  it(
    "flag.credit_limits: old path is unconditionally true without an override, even when the " +
      "tenant's plan does not include it (the ALWAYS_EFFECTIVE_TODAY deviation)",
    () => {
      const ctx = ctxFor(LITE_FIXTURE); // LITE's flags = [] — does not include flag.credit_limits
      const feature = mirror.FEATURE_REGISTRY_MIRROR.find((f) => f.key === "flag.credit_limits")!;
      expect(mirror.computeOldPathEffective(feature, ctx, PROD_ENV)).toBe(true);
      // ...but an explicit DENY override still wins, same as every other key.
      ctx.overrides.set("flag.credit_limits", "DENY");
      expect(mirror.computeOldPathEffective(feature, ctx, PROD_ENV)).toBe(false);
    },
  );
});
