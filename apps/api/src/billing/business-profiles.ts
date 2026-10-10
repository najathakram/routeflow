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

/**
 * Lead ruling (all-or-nothing as far as Stripe allows): paid add-ons are disabled in REVERSE
 * dependency order — `driver_payments` (which requires anyOf the fleet keys) first, then the fleet
 * keys in reverse — so a failure part-way leaves a valid configuration: driver payments is never
 * on without a fleet key, and the last fleet key goes only after everything that depends on it.
 */
export const BILLING_DISABLE_ORDER = ["driver_payments", ...[...FLEET_KEYS].reverse()] as const;

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
  {
    key: "delivery_pos",
    label: "Delivery + POS",
    // `delivery` (not `both`): `both` adds carrier shipping, and no registry mode offers delivery
    // plus pickup. The counter is `counter_sales: "on"`, so it is optional beside the delivery runs.
    description:
      "Delivers on its own trucks and also sells over the counter: delivery routes on, counter sales on.",
    fleet: true,
    modes: { fulfilment_model: "delivery", counter_sales: "on" },
  },
];

export function businessProfileByKey(key: string): BusinessProfileDef | undefined {
  return BUSINESS_PROFILES.find((p) => p.key === key);
}

/**
 * The profile's modes the FEATURE REGISTRY does not offer (`available: false`) — SA-671 M1. A
 * profile with any is unavailable: listed disabled, and `plan()` refuses it with
 * `BUSINESS_PROFILE_UNAVAILABLE` even when the tenant already stores that mode (an unchanged mode
 * is skipped by the planner, so checking only the changes would let the rest of the profile —
 * the DENYs, `counter_sales` — through).
 */
export function unavailableModes(def: BusinessProfileDef): { key: string; mode: string }[] {
  return Object.entries(def.modes)
    .filter(([key, mode]) => registryRow(key)?.config?.modes[mode]?.available !== true)
    .map(([key, mode]) => ({ key, mode }));
}

export function toBusinessProfileSummary(def: BusinessProfileDef): BusinessProfileSummary {
  return {
    key: def.key as BusinessProfileSummary["key"],
    label: def.label,
    description: def.description,
    available: unavailableModes(def).length === 0,
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
  /** Modules held through an add-on row the tenant PAYS for (a Stripe item or a price). */
  paying?: ReadonlySet<string>;
  /** The subset of `paying` billed MANUALLY (a price, no Stripe item). */
  manualPay?: ReadonlySet<string>;
  modes: Record<string, string>;
}

/**
 * Per module: `replace` when an opposite override is active (revoke it, then create), `skip` when
 * the tenant already is that way, else `create`. Modes list only what changes.
 *
 * Owner ruling (money): a module a fleet-OFF profile switches off that the tenant PAYS for goes to
 * `billing` as a `disable` — the existing add-on disable switches it off AND stops its billing —
 * so it needs no DENY override (unless a GRANT override also holds it; overrides are absolute).
 * A comped module (no paid row) is switched off with a DENY, never a billing call.
 */
export function planBusinessProfile(
  def: BusinessProfileDef,
  state: BusinessProfileState,
): BusinessProfilePlan {
  const effect: "GRANT" | "DENY" = def.fleet ? "GRANT" : "DENY";
  const opposite = def.fleet ? "DENY" : "GRANT";
  const disables = def.fleet ? [] : BILLING_DISABLE_ORDER.filter((k) => state.paying?.has(k));
  const overrides = PROFILE_MODULE_KEYS.map((featureKey) => {
    const active = state.overrides.get(featureKey);
    const held = disables.includes(featureKey) ? false : (state.holds[featureKey] ?? false);
    const action: "create" | "replace" | "skip" =
      active === opposite ? "replace" : held === def.fleet ? "skip" : "create";
    return { featureKey, effect, action };
  });
  const modes = Object.entries(def.modes)
    .map(([key, to]) => ({ key, from: state.modes[key] ?? "unset", to }))
    .filter((m) => m.from !== m.to);
  return {
    overrides,
    modes,
    billing: disables.map((featureKey) => ({
      featureKey,
      action: "disable" as const,
      manual: state.manualPay?.has(featureKey) ?? false,
    })),
  };
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

/**
 * The plan in plain English, one line per change, in APPLY order (billing disables → grants →
 * modes → denies); skips say nothing.
 */
export function describeBusinessProfilePlan(plan: BusinessProfilePlan): string[] {
  const { billing, changes } = describeBusinessProfileSections(plan);
  return [...billing, ...changes];
}

/**
 * The plan in plain English, split: `billing` (one line per `plan.billing` entry, in its order) and
 * `changes` (everything else), so a client never has to slice `summary` by position (#3220 review).
 * A grant is a comp: it adds no charge, and says so.
 */
export function describeBusinessProfileSections(plan: BusinessProfilePlan): {
  billing: string[];
  changes: string[];
} {
  const labelOf = (key: string) => registryRow(key)?.label ?? key;
  const overrideLine = (o: BusinessProfilePlan["overrides"][number]) => {
    const replaced = o.effect === "GRANT" ? "off" : "on";
    const base =
      o.effect === "GRANT"
        ? `Turn on ${labelOf(o.featureKey)}: turned on free (comp), no charge added`
        : `Turn off ${labelOf(o.featureKey)}`;
    return o.action === "replace" ? `${base} (replaces the current "${replaced}" override)` : base;
  };
  // Owner ruling (money): a paid module is switched off by disabling its add-on, which stops its
  // billing — say exactly that.
  // A MANUAL-pay add-on has no Stripe item to stop: the disable takes it off RouteFlow's ledger,
  // but the admin must take it off the tenant's manual invoice themselves (SA, no STOP-notice
  // helper exists to write one).
  const billing = (plan.billing ?? []).map((b) =>
    b.manual
      ? `${labelOf(b.featureKey)} will be switched off; remove it from their manual invoice`
      : `${labelOf(b.featureKey)} will be switched off and its billing stopped`,
  );
  const changing = plan.overrides.filter((o) => o.action !== "skip");
  const grants = changing.filter((o) => o.effect === "GRANT").map(overrideLine);
  const denies = changing.filter((o) => o.effect === "DENY").map(overrideLine);
  const modes = plan.modes.map(
    (m) => `${labelOf(m.key)}: ${modeLabel(m.key, m.from)} → ${modeLabel(m.key, m.to)}`,
  );
  return { billing, changes: [...grants, ...modes, ...denies] };
}
