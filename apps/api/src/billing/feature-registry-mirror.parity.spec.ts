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
    billingSkus: string[];
  }>;
  DARK_PLAN_FLAGS: Set<string>;
  ALWAYS_ENFORCED_PLAN_KEYS: Set<string>;
  ALWAYS_EFFECTIVE_TODAY: Set<string>;
  isPlanFlagEnforcementOn: (env: NodeJS.ProcessEnv) => boolean;
  isDarkFlag: (key: string, env: NodeJS.ProcessEnv) => boolean;
  allowsFlag: (planKey: string, entFlags: string[], key: string, env: NodeJS.ProcessEnv) => boolean;
  isAlwaysEnforcedPlan: (planKey: string | null) => boolean;
  lossMechanism: (feature: { key: string; via: string }) => string;
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

  it(
    "mirrors billing.skus for every key (N1, 2026-09-19) — only consulted by publish-and-repin.mjs's " +
      "apply-time billable-key expiry/reporting decision, never by the effective-boolean computation",
    () => {
      const byKey = new Map(mirror.FEATURE_REGISTRY_MIRROR.map((f) => [f.key, f]));
      for (const real of FEATURE_REGISTRY) {
        expect(byKey.get(real.key)!.billingSkus).toEqual([...real.billing.skus]);
      }
      // Pins the exact set N1 is about: dark AND billable AND NOT already excluded from --apply's
      // default write set by the F3 addon-gate-courtesy mechanism (ocr is dark + billable too, but
      // it's RequireAddon-via, so it never reaches applicableLosses by default in the first
      // place — N1 is specifically about the gap F3's exclusion does NOT cover: a
      // RequirePlanFlag-keyed dark row with a real SKU sailing through unexcluded). A registry
      // change silently adding/removing a billing SKU from one of these three fails this test
      // rather than surfacing only as a wording mismatch in a PR description.
      const billableKeys = mirror.FEATURE_REGISTRY_MIRROR.filter(
        (f) => f.billingSkus.length > 0,
      ).map((f) => f.key);
      const darkBillablePlanFlagKeys = mirror.FEATURE_REGISTRY_MIRROR.filter(
        (f) => f.billingSkus.length > 0 && f.state === "dark" && f.via === "RequirePlanFlag",
      )
        .map((f) => f.key)
        .sort();
      expect(billableKeys.length).toBeGreaterThan(0);
      expect(darkBillablePlanFlagKeys).toEqual([
        "addon.buyer_portal",
        "flag.analytics",
        "flag.forecasting",
      ]);
    },
  );

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
        // N4 fix: isPlanFlagEnforcementOn itself, actually called and asserted (the previous
        // version of this test claimed to cover it here but only repeated the isDarkFlag
        // comparison from the loop above — the function was imported and cast but never invoked).
        expect(mirror.isPlanFlagEnforcementOn(env as NodeJS.ProcessEnv)).toBe(
          isPlanFlagEnforcementOn(env as NodeJS.ProcessEnv),
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
  // The REAL, CURRENT production value (project_entitlements_one_rule_2026-09-17.md: "Mitigated
  // 06:11Z by deleting the env var... PLAN_FLAG_ENFORCEMENT stays OFF (not re-enabled)") — the
  // 2026-09-17 P0 was the ON flip; it was reverted the same morning. publish-and-repin.mjs
  // defaults to this. ON_ENV exists only to prove the --plan-flag-enforcement=on override path
  // computes something different and correct, in case the flag is ever re-enabled.
  const OFF_ENV = { PLAN_FLAG_ENFORCEMENT: "off" } as NodeJS.ProcessEnv;
  const ON_ENV = { PLAN_FLAG_ENFORCEMENT: "on" } as NodeJS.ProcessEnv;

  function lossesFor(fixture: (typeof ALL_FIXTURES)[number], env: NodeJS.ProcessEnv) {
    const ctx = ctxFor(fixture);
    return mirror.FEATURE_REGISTRY_MIRROR.filter((f) => {
      const oldEff = mirror.computeOldPathEffective(f, ctx, env);
      const newEff = mirror.computeNewPathEffective(f, ctx);
      return oldEff && !newEff;
    }).map((f) => f.key);
  }

  it(
    "V11_PIN_FIXTURE under the REAL current config (enforcement OFF): shows LOSSES for every " +
      "DARK_PLAN_FLAGS key it doesn't hold (11 — the courtesy allow is NOT limited to " +
      "PREPIN_DARK_FLAGS while enforcement is off), the 3 RequireAddon-dark keys with no active " +
      "addon (addon-gate courtesy has no env kill switch at all), and flag.credit_limits (the " +
      "always-effective-today deviation, unconditional while enforcement is off) — 15 total; " +
      "'a fixture tenant that has a feature only via the dark list'",
    () => {
      const losses = lossesFor(V11_PIN_FIXTURE, OFF_ENV).sort();
      expect(losses).toEqual(
        [
          "flag.analytics",
          "flag.ap_bills",
          "flag.import_integrations",
          "flag.forecasting",
          "flag.pricing_tiers",
          "flag.estimates",
          "flag.recurring_invoices",
          "flag.credit_notes",
          "flag.suppliers",
          "flag.messaging",
          "addon.buyer_portal",
          "ocr",
          "crm_gohighlevel",
          "email.connected_mailbox",
          "flag.credit_limits",
        ].sort(),
      );
    },
  );

  it(
    "V11_PIN_FIXTURE under a HYPOTHETICAL enforcement=on: only the 5 PREPIN_DARK_FLAGS keys " +
      "(the interim patch that has no enforcement toggle) plus the 3 addon-dark keys — 8 total; " +
      "flag.credit_limits shows NO diff at all here (old and new both reduce to the same " +
      "entFlags.includes check once the always-effective deviation stops applying), proving the " +
      "--plan-flag-enforcement flag actually changes the computation rather than being decorative",
    () => {
      const losses = lossesFor(V11_PIN_FIXTURE, ON_ENV).sort();
      expect(losses).toEqual(
        [
          "flag.estimates",
          "flag.recurring_invoices",
          "flag.credit_notes",
          "flag.suppliers",
          "flag.messaging",
          "ocr",
          "crm_gohighlevel",
          "email.connected_mailbox",
        ].sort(),
      );
    },
  );

  it(
    "LITE_FIXTURE under the real current config (enforcement OFF): the ONLY loss is " +
      "flag.credit_limits — LITE is always-enforced, so every ORDINARY courtesy-driven loss (the " +
      "P0 incident's whole failure class) is correctly absent regardless of enforcement; the one " +
      "exception is the plan-independent always-effective-today deviation, which does not check " +
      "isAlwaysEnforcedPlan and so applies to LITE too",
    () => {
      expect(lossesFor(LITE_FIXTURE, OFF_ENV)).toEqual(["flag.credit_limits"]);
    },
  );

  it(
    "LITE_FIXTURE under enforcement=on: zero losses — with the deviation inactive, LITE's empty " +
      "flag set means flag.credit_limits reduces to the same (false, false) as every other " +
      "unheld flag, no different from any other key",
    () => {
      expect(lossesFor(LITE_FIXTURE, ON_ENV)).toEqual([]);
    },
  );

  it(
    "a plan that already grants flag.credit_limits explicitly (e.g. a future v12-shaped catalog) " +
      "closes even that one exception under BOTH enforcement values — 'a fixture tenant whose " +
      "access is fully explained by preset/grants → zero diff' in the literal, no-exceptions sense",
    () => {
      const fixture = {
        ...LITE_FIXTURE,
        name: "lite-with-credit-limits",
        definitions: [{ planKey: "LITE", featureFlags: ["flag.credit_limits"] }],
      };
      expect(lossesFor(fixture, OFF_ENV)).toEqual([]);
      expect(lossesFor(fixture, ON_ENV)).toEqual([]);
    },
  );

  it("an active GRANT override makes old and new path agree (never a loss or gain), regardless of enforcement", () => {
    const ctx = ctxFor(V11_PIN_FIXTURE);
    ctx.overrides.set("flag.estimates", "GRANT");
    const feature = mirror.FEATURE_REGISTRY_MIRROR.find((f) => f.key === "flag.estimates")!;
    for (const env of [OFF_ENV, ON_ENV]) {
      expect(mirror.computeOldPathEffective(feature, ctx, env)).toBe(true);
      expect(mirror.computeNewPathEffective(feature, ctx)).toBe(true);
    }
  });

  it(
    "flag.credit_limits: old path is unconditionally true while enforcement is off, EVEN OVER an " +
      "explicit DENY override (N3 fix, 2026-09-19) — matching orders.service.ts's " +
      "isCreditLimitCheckEnabled() exactly, which returns before ever consulting overrides in " +
      "that state; while enforcement is on, the deviation is inactive and overrides decide " +
      "normally, same as every other key",
    () => {
      const ctx = ctxFor(LITE_FIXTURE); // LITE's flags = [] — does not include flag.credit_limits
      const feature = mirror.FEATURE_REGISTRY_MIRROR.find((f) => f.key === "flag.credit_limits")!;
      expect(mirror.computeOldPathEffective(feature, ctx, OFF_ENV)).toBe(true);
      expect(mirror.computeOldPathEffective(feature, ctx, ON_ENV)).toBe(false);

      // A GRANT is redundant with the deviation while off (both true), but proves the ordering
      // doesn't break the ordinary case either.
      ctx.overrides.set("flag.credit_limits", "GRANT");
      expect(mirror.computeOldPathEffective(feature, ctx, OFF_ENV)).toBe(true);
      expect(mirror.computeOldPathEffective(feature, ctx, ON_ENV)).toBe(true);

      // The N3 case: an explicit DENY does NOT win while enforcement is off — production ignores
      // it entirely in that state — but DOES win once enforcement is on, when the real service
      // actually reaches the override-consulting branch.
      ctx.overrides.set("flag.credit_limits", "DENY");
      expect(mirror.computeOldPathEffective(feature, ctx, OFF_ENV)).toBe(true);
      expect(mirror.computeOldPathEffective(feature, ctx, ON_ENV)).toBe(false);
    },
  );

  it(
    "N3: a DENY override on flag.credit_limits while enforcement is off produces a real, " +
      "reportable LOSS (old=true via the deviation, new=false via the override) rather than " +
      "silently agreeing at (false, false) the way the pre-N3 ordering did",
    () => {
      const ctx = ctxFor(LITE_FIXTURE);
      ctx.overrides.set("flag.credit_limits", "DENY");
      const feature = mirror.FEATURE_REGISTRY_MIRROR.find((f) => f.key === "flag.credit_limits")!;
      expect(mirror.computeOldPathEffective(feature, ctx, OFF_ENV)).toBe(true);
      expect(mirror.computeNewPathEffective(feature, ctx)).toBe(false);
    },
  );

  it("lossMechanism classifies every FEATURE_REGISTRY_MIRROR key correctly by structural shape", () => {
    for (const f of mirror.FEATURE_REGISTRY_MIRROR) {
      const m = mirror.lossMechanism(f);
      if (f.via === "RequireAddon" || f.via === "guard") {
        expect(m).toBe("addon-gate-courtesy");
      } else if (f.key === "flag.credit_limits") {
        expect(m).toBe("credit-limit-service-toggle");
      } else {
        expect(m).toBe("plan-flag-courtesy");
      }
    }
  });
});
