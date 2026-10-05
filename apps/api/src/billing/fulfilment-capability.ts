import type { FulfilmentCapability, FulfilmentMethod } from "@routeflow/types";
import type { AddonService } from "./addon.service";
import type { FeatureOverrideService } from "./feature-override.service";
import type { FeatureConfigService } from "./feature-config.service";
import { FEATURE_REGISTRY, gateVia } from "./feature-registry";

/**
 * The two keys that make a tenant a delivery operation (the fleet modules). `driver_payments` is
 * deliberately NOT here: it is gated via "guard", so `can()` is true for almost every tenant and
 * including it would neuter the 409 on delivery/both.
 */
export const FLEET_KEYS = ["recurring_routes", "order_delivery"] as const;

/** What each stored mode offers. SHIP semantics come ONLY from the ship-family modes (SA-649 R3). */
const BY_MODE: Record<string, { methods: FulfilmentMethod[]; opensAs: "order" | "counter" }> = {
  delivery: { methods: ["ROUTE"], opensAs: "order" },
  ship: { methods: ["SHIP"], opensAs: "order" },
  both: { methods: ["ROUTE", "SHIP"], opensAs: "order" },
  pickup: { methods: ["PICKUP"], opensAs: "counter" },
  pickup_ship: { methods: ["PICKUP", "SHIP"], opensAs: "counter" },
};

/**
 * Business profiles 1A: the ONE place the fulfilment capability is derived, from the stored
 * `fulfilment_model` and `counter_sales` modes and whether either fleet module is held.
 *
 * `unset` (every existing tenant) is TODAY exactly: staff may pick ROUTE or SHIP, ROUTE is the
 * default (orders.service `dto ?? customer ?? ROUTE`), the buyer portal offers NO choice (portalMethods [], portalDefault null), no counter, and
 * fleet comes from the modules alone. An unknown stored value is treated as unset.
 */
export function deriveFulfilmentCapability(input: {
  mode: string;
  counterSales: string;
  fleet: boolean;
}): FulfilmentCapability {
  const { fleet } = input;
  const def = BY_MODE[input.mode];
  const methods: FulfilmentMethod[] = def ? [...def.methods] : ["ROUTE", "SHIP"];
  const staffDefault = methods[0];
  const inStore = input.mode === "pickup" || input.mode === "pickup_ship";
  const counter = inStore ? "always" : input.counterSales === "on" ? "optional" : "off";
  const needsFleet = input.mode === "delivery" || input.mode === "both";
  return {
    methods,
    staffDefault,
    staffOpensAs: def?.opensAs ?? "order",
    // UNSET: today the buyer gets NO choice (the server applies customer default ?? ROUTE), so
    // there are no portal methods and no portal default. A configured mode mirrors staff.
    portalMethods: def ? [...methods] : [],
    portalDefault: def ? staffDefault : null,
    counter,
    fleet,
    consistent: !(needsFleet && !fleet),
  };
}

/**
 * The add-on keys a tenant effectively holds: its active rows, with overrides absolute (GRANT
 * surfaces a key, DENY hides one; only RequireAddon-gated keys, Opus review of 8130b204 item 6).
 * Shared by `me/addons` and the capability answer, so "fleet" can never disagree with AddonGuard.
 */
export async function heldAddonKeys(
  addonService: Pick<AddonService, "getActiveAddons">,
  featureOverrides: Pick<FeatureOverrideService, "allActive">,
  tenantId: string,
): Promise<Set<string>> {
  const active = await addonService.getActiveAddons(tenantId);
  const overrides = await featureOverrides.allActive(tenantId);
  const addons = new Set(active);
  for (const [key, effect] of overrides) {
    if (gateVia(key) !== "RequireAddon") continue;
    if (effect === "GRANT") addons.add(key);
    else addons.delete(key);
  }
  return addons;
}

/**
 * ONE fleet resolver: true when either fleet module is effectively held (add-on rows with
 * overrides absolute). Used by the capability answer AND the 409 guard in FeatureConfigService,
 * so the two can never disagree.
 */
export async function isFleetHeld(
  addonService: Pick<AddonService, "getActiveAddons">,
  featureOverrides: Pick<FeatureOverrideService, "allActive">,
  tenantId: string,
): Promise<boolean> {
  const held = await heldAddonKeys(addonService, featureOverrides, tenantId);
  return FLEET_KEYS.some((k) => held.has(k));
}

/** The services the tenant-level capability read needs (the same three `GET /tenants/me/features` uses). */
export interface FulfilmentCapabilityDeps {
  featureConfig: Pick<FeatureConfigService, "getEffectiveMode">;
  addonService: Pick<AddonService, "getActiveAddons">;
  featureOverrides: Pick<FeatureOverrideService, "allActive">;
}

/**
 * SA-666a: a stored mode the registry marks `available: false` reads as `unset` (today). The effective-mode
 * read only checks a mode's `requires`, so availability is honoured here, at the one place the capability is
 * built. Every fulfilment_model / counter_sales mode is available on master today, so this is dormant until
 * a mode is withdrawn.
 */
function availableOrUnset(key: string, mode: string): string {
  const def = FEATURE_REGISTRY.find((f) => f.key === key)?.config?.modes[mode];
  return def && def.available === false ? "unset" : mode;
}

/** What the capability derivation reads, each read answered on its own so a caller keeps ITS failure rule. */
export interface FulfilmentInputs {
  fulfilmentMode: string;
  counterSales: string;
  /** null = the fleet read failed (the caller decides: 503 on the tenants endpoint, counter off on the gate). */
  fleet: boolean | null;
  /** true when either mode read failed (that mode then reads as "unset"). */
  modesFailed: boolean;
}

/**
 * The ONE place the capability's inputs are read — `getEffectiveMode` for `fulfilment_model` and
 * `counter_sales`, and `isFleetHeld` — shared by the counter gate and `GET /tenants/me/features`. It never
 * throws: a failed mode read answers "unset" (+ `modesFailed`), a failed fleet read answers `null`, so each
 * caller applies its own pinned failure behaviour to the same read.
 */
export async function readFulfilmentInputs(
  deps: FulfilmentCapabilityDeps,
  tenantId: string,
): Promise<FulfilmentInputs> {
  let modesFailed = false;
  const mode = (key: string) =>
    deps.featureConfig.getEffectiveMode(tenantId, key).then(
      (m) => availableOrUnset(key, m),
      () => {
        modesFailed = true;
        return "unset";
      },
    );
  const [fulfilmentMode, counterSales, fleet] = await Promise.all([
    mode("fulfilment_model"),
    mode("counter_sales"),
    isFleetHeld(deps.addonService, deps.featureOverrides, tenantId).then(
      (f): boolean | null => f,
      () => null,
    ),
  ]);
  return { fulfilmentMode, counterSales, fleet, modesFailed };
}

/** The derivation over {@link readFulfilmentInputs}'s answer (a null fleet reads as false). */
export function capabilityFromInputs(inputs: FulfilmentInputs): FulfilmentCapability {
  return deriveFulfilmentCapability({
    mode: inputs.fulfilmentMode,
    counterSales: inputs.counterSales,
    fleet: inputs.fleet ?? false,
  });
}

/**
 * The tenant-level capability for server-side rules (the counter-sale gate): STRICT. A null tenant or ANY
 * failed read (a mode, the fleet, the overrides) answers the "unset" capability (counter "off"): a failed
 * read never blocks the caller and never guesses "on".
 */
export async function readFulfilmentCapability(
  deps: FulfilmentCapabilityDeps,
  tenantId: string | null,
): Promise<FulfilmentCapability> {
  const off = () =>
    deriveFulfilmentCapability({ mode: "unset", counterSales: "unset", fleet: false });
  if (!tenantId) return off();
  const inputs = await readFulfilmentInputs(deps, tenantId);
  if (inputs.modesFailed || inputs.fleet === null) return off();
  return capabilityFromInputs(inputs);
}
