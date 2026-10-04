import type { BusinessProfilePlan, BusinessProfileSummary } from "@routeflow/types";
import { FEATURE_REGISTRY } from "./feature-registry";
import { FLEET_KEYS } from "./fulfilment-capability";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * Business profiles — registry DATA, plus the pure planner and describer.
 *
 * A profile is a named starting bundle a platform admin applies to one tenant. It uses only the
 * EXISTING module switches (no new plan flags) and the existing config rows:
 *
 * - `fleet: true` grants the three fleet modules, `fleet: false` denies them. Order matters:
 *   `driver_payments` requires `anyOf` the two fleet add-ons, so it comes last.
 * - `modes` are `fulfilment_model` (and `counter_sales` for the in-store profiles), applied through
 *   `FeatureConfigService.set` — never a config row written directly.
 *
 * A tenant nobody applied a profile to is untouched (`unset` = today). The capability answer stays
 * `deriveFulfilmentCapability` (fulfilment-capability.ts); nothing here derives a second one.
 */
export const PROFILE_MODULE_KEYS = [...FLEET_KEYS, "driver_payments"] as const;

export interface BusinessProfileDef {
  key: string;
  label: string;
  description: string;
  /** true = grant every PROFILE_MODULE_KEYS module; false = deny every one. */
  fleet: boolean;
  /** Config modes by registry key. */
  modes: Record<string, string>;
}

export const BUSINESS_PROFILES: readonly BusinessProfileDef[] = [
  {
    key: "delivery_distributor",
    label: "Delivery distributor",
    description: "Delivers on its own trucks: routes, ad hoc delivery and at-door payments on.",
    fleet: true,
    modes: { fulfilment_model: "delivery" },
  },
  {
    key: "shipping_wholesaler",
    label: "Shipping wholesaler",
    description: "Ships by carrier: no delivery fleet.",
    fleet: false,
    modes: { fulfilment_model: "ship" },
  },
  {
    key: "in_store_retailer",
    label: "In-store retailer",
    description: "Sells over the counter for in-store pickup: no delivery fleet.",
    fleet: false,
    modes: { fulfilment_model: "pickup", counter_sales: "on" },
  },
  {
    key: "in_store_shipping_retailer",
    label: "In-store + shipping retailer",
    description: "Sells over the counter and ships by carrier: no delivery fleet.",
    fleet: false,
    modes: { fulfilment_model: "pickup_ship", counter_sales: "on" },
  },
];

export function businessProfileByKey(key: string): BusinessProfileDef | undefined {
  return BUSINESS_PROFILES.find((p) => p.key === key);
}

export function toBusinessProfileSummary(def: BusinessProfileDef): BusinessProfileSummary {
  return {
    key: def.key as BusinessProfileSummary["key"],
    label: def.label,
    description: def.description,
    available: true,
    modes: { ...def.modes },
    grants: def.fleet ? [...PROFILE_MODULE_KEYS] : [],
    denies: def.fleet ? [] : [...PROFILE_MODULE_KEYS],
  };
}

/**
 * The tenant's current state, as the EXISTING services report it:
 * - `overrides`: active override per key (FeatureOverrideService).
 * - `holds`: `FeatureConfigService.can()` per module (an override is absolute, then add-on rows).
 * - `modes`: the STORED value per config key (`FeatureConfigService.getState().value`).
 */
export interface BusinessProfileState {
  overrides: Map<string, "GRANT" | "DENY">;
  holds: Record<string, boolean>;
  modes: Record<string, string>;
}

/**
 * Per module: `replace` when an opposite override is active (revoke it, then create), `skip` when
 * the tenant already is that way, else `create`. Modes list only what changes.
 */
export function planBusinessProfile(
  def: BusinessProfileDef,
  state: BusinessProfileState,
): BusinessProfilePlan {
  const effect: "GRANT" | "DENY" = def.fleet ? "GRANT" : "DENY";
  const opposite = def.fleet ? "DENY" : "GRANT";
  const overrides = PROFILE_MODULE_KEYS.map((featureKey) => {
    const active = state.overrides.get(featureKey);
    const action: "create" | "replace" | "skip" =
      active === opposite
        ? "replace"
        : (state.holds[featureKey] ?? false) === def.fleet
          ? "skip"
          : "create";
    return { featureKey, effect, action };
  });
  const modes = Object.entries(def.modes)
    .map(([key, to]) => ({ key, from: state.modes[key] ?? "unset", to }))
    .filter((m) => m.from !== m.to);
  return { overrides, modes };
}

export interface BusinessProfileViolation {
  code: typeof API_ERROR_CODES.FULFILMENT_MODE_NEEDS_FLEET;
  key: string;
  mode: string;
}

/**
 * Validate the WHOLE post-apply state before any write: `FeatureConfigService.set` checks the
 * fleet rule against the SAVED state, so a profile whose end state would put delivery/both on a
 * tenant with no fleet key is refused up front rather than half-applied. (The apply path also
 * writes grants → modes → denies, so every intermediate step is valid as well.)
 */
export function postApplyViolations(
  def: BusinessProfileDef,
  state: BusinessProfileState,
): BusinessProfileViolation[] {
  const held = (key: string) => {
    const summary = toBusinessProfileSummary(def);
    if (summary.grants.includes(key)) return true;
    if (summary.denies.includes(key)) return false;
    return state.holds[key] ?? false;
  };
  const mode = def.modes.fulfilment_model;
  if ((mode === "delivery" || mode === "both") && !FLEET_KEYS.some(held)) {
    return [{ code: API_ERROR_CODES.FULFILMENT_MODE_NEEDS_FLEET, key: "fulfilment_model", mode }];
  }
  return [];
}

function registryRow(key: string) {
  return FEATURE_REGISTRY.find((f) => f.key === key);
}

function modeLabel(key: string, mode: string): string {
  return registryRow(key)?.config?.modes[mode]?.label ?? mode;
}

/** The plan in plain English, one line per change, in apply order; skips say nothing. */
export function describeBusinessProfilePlan(plan: BusinessProfilePlan): string[] {
  const overrideLine = (o: BusinessProfilePlan["overrides"][number]) => {
    const verb = o.effect === "GRANT" ? "Turn on" : "Turn off";
    const label = registryRow(o.featureKey)?.label ?? o.featureKey;
    const replaced = o.effect === "GRANT" ? "off" : "on";
    return o.action === "replace"
      ? `${verb} ${label} (replaces the current "${replaced}" override)`
      : `${verb} ${label}`;
  };
  const changing = plan.overrides.filter((o) => o.action !== "skip");
  const grants = changing.filter((o) => o.effect === "GRANT").map(overrideLine);
  const denies = changing.filter((o) => o.effect === "DENY").map(overrideLine);
  const modes = plan.modes.map(
    (m) =>
      `${registryRow(m.key)?.label ?? m.key}: ${modeLabel(m.key, m.from)} → ${modeLabel(m.key, m.to)}`,
  );
  return [...grants, ...modes, ...denies];
}
