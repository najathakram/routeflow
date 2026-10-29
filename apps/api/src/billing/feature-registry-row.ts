// `import type` only — see feature-registry.ts: @routeflow/types is raw TS, never a value import.
import type { FeatureRegistryRow } from "@routeflow/types";
import type { FeatureDef } from "./feature-registry";

/**
 * The ONE builder of the `GET /platform-admin/features/registry` wire row. Moved verbatim out of
 * the controller (SA-950 piece A) so a field added to `FeatureRegistryRow` is compile-checked
 * against this mapping and unit-testable without booting the controller.
 */
export function toFeatureRegistryRow(f: FeatureDef): FeatureRegistryRow {
  const { nature } = f;
  return {
    key: f.key,
    kind: f.kind,
    area: f.area,
    label: f.label,
    description: f.description,
    lifecycle: f.gate.state === "dark" ? "beta" : "ga",
    internal: f.internal ?? false,
    // SA-950 A3: the back office reads the row's nature from the registry, never a hand list.
    purpose: nature.purpose,
    ...(nature.purpose === "release"
      ? { release: { stage: nature.release.stage } }
      : { category: nature.category }),
    keywords: [...f.keywords],
    ...(f.incomplete ? { incomplete: { missing: f.incomplete.missing } } : {}),
    // Opus review of 8130b204, item 2: `via` lets the web warn before creating an override
    // that has no wired consultation point. "none" is a verified-no-gate key by definition
    // (catalog metadata only) -- an override there can never have any effect.
    gate: { via: f.gate.via, state: f.gate.state },
    billing: { skus: [...f.billing.skus] },
    // B519: the console needs this to warn before enabling a key whose prerequisites
    // aren't met — verbatim from the registry, never a client-side mirror.
    ...(f.requires
      ? {
          requires: {
            ...(f.requires.allOf ? { allOf: [...f.requires.allOf] } : {}),
            ...(f.requires.anyOf ? { anyOf: [...f.requires.anyOf] } : {}),
          },
        }
      : {}),
    ...(f.config
      ? {
          config: {
            fallbackMode: f.config.fallbackMode,
            modes: Object.entries(f.config.modes).map(([key, m]) => ({
              key,
              label: m.label,
              lifecycle: "ga" as const,
              ...(m.requires?.allOf ? { requires: [...m.requires.allOf] } : {}),
            })),
          },
        }
      : {}),
  };
}
