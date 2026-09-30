import { FEATURE_REGISTRY, type FeatureConfigMode, type FeatureDef } from "./feature-registry";

/**
 * Feature grants v2 brief C (PR-4), oracle 1 — registry-shape pins for every `config` block
 * (not just `routes_dispatch`): `fallbackMode` names a real mode, every `requires.allOf` target
 * is a registered key, no config-mode cycle back to the feature that requires it, and the
 * config-mode `requires` shape is AND-only (`allOf`) — never an `anyOf` OR-group, and never more
 * than one mode active per tenant per feature (XOR), which the type system + DB unique index
 * already guarantee structurally; the runtime checks below prove it holds for the DATA too, red
 * first against a deliberately-broken fixture before trusting it holds for the real registry.
 */

/** A minimal, deliberately-invalid stand-in registry — proves each check actually fails on a
 * bad fixture (red-first) before trusting it passes on the real FEATURE_REGISTRY (green). */
function fixtureRegistry(overrides: Partial<FeatureDef> = {}): readonly FeatureDef[] {
  const base: FeatureDef = {
    key: "fixture_key",
    kind: "boolean",
    area: "platform",
    label: "Fixture",
    description: "Fixture feature for feature-config.spec.ts oracle 1.",
    gate: {
      via: "none",
      state: "none",
      added: "2026-09-17",
      routes: [],
      grantPath: "x",
      backfill: "x",
    },
    billing: { skus: [], selfService: false },
    defaultGranted: true,
    config: {
      fallbackMode: "unset",
      modes: {
        unset: { label: "Unset", available: true, settings: [] },
      },
    },
  };
  return [{ ...base, ...overrides }];
}

function fallbackModeInModes(registry: readonly FeatureDef[]): string[] {
  return registry
    .filter((f) => f.config && !(f.config.fallbackMode in f.config.modes))
    .map((f) => f.key);
}

function requiresReferenceRealKeys(registry: readonly FeatureDef[]): string[] {
  const keys = new Set(registry.map((f) => f.key));
  const bad: string[] = [];
  for (const f of registry) {
    for (const [modeName, mode] of Object.entries(f.config?.modes ?? {})) {
      for (const ref of mode.requires?.allOf ?? []) {
        if (!keys.has(ref)) bad.push(`${f.key}.config.modes.${modeName} -> ${ref}`);
      }
    }
  }
  return bad;
}

/** A config-mode cycle: feature A's mode requires key B, and B (itself carrying a config block)
 * has a mode requiring A back — neither this registry nor a real one should ever have one. */
function requiresAcyclic(registry: readonly FeatureDef[]): string[] {
  const byKey = new Map(registry.map((f) => [f.key, f]));
  const cyclic: string[] = [];
  for (const f of registry) {
    const allRequired = new Set<string>();
    for (const mode of Object.values(f.config?.modes ?? {})) {
      for (const ref of mode.requires?.allOf ?? []) allRequired.add(ref);
    }
    for (const requiredKey of allRequired) {
      const requiredFeature = byKey.get(requiredKey);
      for (const mode of Object.values(requiredFeature?.config?.modes ?? {})) {
        if (mode.requires?.allOf?.includes(f.key)) cyclic.push(`${f.key} <-> ${requiredKey}`);
      }
    }
  }
  return cyclic;
}

function hasOrGroup(mode: FeatureConfigMode): boolean {
  // Structural: FeatureConfigMode's `requires` type has no `anyOf` field at all, so this can
  // only ever be true if something bypasses the type (a cast, a JSON-sourced object) — the scan
  // is the runtime half of that compile-time guarantee.
  return "anyOf" in (mode.requires ?? {});
}

describe("feature-config.spec.ts — FEATURE_REGISTRY config-mode invariants (oracle 1)", () => {
  describe("red first — a deliberately broken fixture fails every check", () => {
    it("fallbackMode not in modes fails", () => {
      const broken = fixtureRegistry({
        config: {
          fallbackMode: "nonexistent_mode",
          modes: { unset: { label: "u", available: true, settings: [] } },
        },
      });
      expect(fallbackModeInModes(broken)).toEqual(["fixture_key"]);
    });

    it("requires.allOf naming an unregistered key fails", () => {
      const broken = fixtureRegistry({
        config: {
          fallbackMode: "unset",
          modes: {
            unset: { label: "u", available: true, settings: [] },
            on: { label: "on", available: true, requires: { allOf: ["ghost_key"] }, settings: [] },
          },
        },
      });
      expect(requiresReferenceRealKeys(broken)).toEqual([
        "fixture_key.config.modes.on -> ghost_key",
      ]);
    });

    it("a two-feature requires cycle fails", () => {
      const cyclic = [
        {
          ...fixtureRegistry()[0],
          key: "a",
          config: {
            fallbackMode: "unset",
            modes: {
              unset: { label: "u", available: true, settings: [] },
              on: { label: "on", available: true, requires: { allOf: ["b"] }, settings: [] },
            },
          },
        },
        {
          ...fixtureRegistry()[0],
          key: "b",
          config: {
            fallbackMode: "unset",
            modes: {
              unset: { label: "u", available: true, settings: [] },
              on: { label: "on", available: true, requires: { allOf: ["a"] }, settings: [] },
            },
          },
        },
      ] as FeatureDef[];
      expect(requiresAcyclic(cyclic).length).toBeGreaterThan(0);
    });

    it("an OR-group (anyOf) on a config mode is detected", () => {
      const withOr = {
        label: "on",
        available: true,
        requires: { allOf: ["x"] },
        settings: [],
      } as FeatureConfigMode;
      (withOr.requires as any).anyOf = ["y"];
      expect(hasOrGroup(withOr)).toBe(true);
      expect(hasOrGroup({ label: "u", available: true, settings: [] })).toBe(false);
    });
  });

  describe("green — the real FEATURE_REGISTRY passes every check", () => {
    it("every config.fallbackMode is a real key in its own config.modes", () => {
      expect(fallbackModeInModes(FEATURE_REGISTRY)).toEqual([]);
    });

    it("every config mode's requires.allOf references a real FEATURE_REGISTRY key", () => {
      expect(requiresReferenceRealKeys(FEATURE_REGISTRY)).toEqual([]);
    });

    it("no config-mode requires.allOf cycle exists", () => {
      expect(requiresAcyclic(FEATURE_REGISTRY)).toEqual([]);
    });

    it("no config mode anywhere in the registry carries an anyOf OR-group", () => {
      const offenders: string[] = [];
      for (const f of FEATURE_REGISTRY) {
        for (const [modeName, mode] of Object.entries(f.config?.modes ?? {})) {
          if (hasOrGroup(mode)) offenders.push(`${f.key}.${modeName}`);
        }
      }
      expect(offenders).toEqual([]);
    });

    it("routes_dispatch: fallbackMode is unset, and unset/mixed/scheduled/adhoc all carry lifecycle 'ga'", () => {
      const row = FEATURE_REGISTRY.find((f) => f.key === "routes_dispatch");
      expect(row?.config?.fallbackMode).toBe("unset");
      const modes = row?.config?.modes ?? {};
      expect(Object.keys(modes).sort()).toEqual(["adhoc", "mixed", "scheduled", "unset"]);
      for (const [name, mode] of Object.entries(modes)) {
        expect(mode.lifecycle).toBe("ga");
        if (name === "mixed") expect(mode.label).toBe("Both");
      }
    });

    it("routes_dispatch: scheduled requires recurring_routes, adhoc requires order_delivery, mixed requires both", () => {
      const row = FEATURE_REGISTRY.find((f) => f.key === "routes_dispatch");
      const modes = row?.config?.modes ?? {};
      expect(modes.scheduled.requires?.allOf).toEqual(["recurring_routes"]);
      expect(modes.adhoc.requires?.allOf).toEqual(["order_delivery"]);
      expect(modes.mixed.requires?.allOf).toEqual(["recurring_routes", "order_delivery"]);
      expect(modes.unset.requires).toBeUndefined();
    });

    it("routes_dispatch stays gate.via 'none' / defaultGranted true (gate policy: no new addon/plan-flag keys)", () => {
      const row = FEATURE_REGISTRY.find((f) => f.key === "routes_dispatch");
      expect(row?.gate.via).toBe("none");
      expect(row?.defaultGranted).toBe(true);
    });
  });
});
