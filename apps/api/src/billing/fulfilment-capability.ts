import type { FulfilmentCapability, FulfilmentMethod } from "@routeflow/types";
import type { AddonService } from "./addon.service";
import type { FeatureOverrideService } from "./feature-override.service";
import { gateVia } from "./feature-registry";

/** The two keys that make a tenant a delivery operation (the fleet modules). */
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
 * default (orders.service `dto ?? customer ?? ROUTE`), the portal offers the same, no counter, and
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
    portalMethods: [...methods],
    portalDefault: staffDefault,
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
