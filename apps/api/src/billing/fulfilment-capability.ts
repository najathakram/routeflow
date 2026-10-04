import type { FulfilmentCapability, FulfilmentMethod } from "@routeflow/types";
import { BadRequestException } from "@nestjs/common";
import type { FulfillPath } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { AddonService } from "./addon.service";
import type { FeatureOverrideService } from "./feature-override.service";
import { gateVia } from "./feature-registry";

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

/**
 * Business profiles 1B: the `fulfillPath` a BUYER portal order is created with, from the seller's
 * portal rule. `undefined` means "send none": OrdersService.create then resolves today's
 * `customer.fulfillPath ?? ROUTE`.
 * - An explicit path must be one the portal offers, else the fixed coded 400. An UNSET seller
 *   offers none (portalMethods []), so every explicit path is refused, as the whitelisting
 *   ValidationPipe refused the field before it existed.
 * - No path: the portal default when it is a FulfillPath (ROUTE | SHIP). A PICKUP default, or no
 *   default (unset), sends none: PICKUP is not an order path (packages/types/api/fulfilment.ts).
 */
export function resolveBuyerFulfillPath(
  requested: FulfillPath | undefined,
  portal: Pick<FulfilmentCapability, "portalMethods" | "portalDefault">,
): FulfillPath | undefined {
  if (requested !== undefined) {
    if (!portal.portalMethods.includes(requested)) {
      throw new BadRequestException({
        code: API_ERROR_CODES.FULFILMENT_PATH_NOT_OFFERED,
        fulfillPath: requested,
        offered: [...portal.portalMethods],
        message: "This seller doesn't offer that delivery method for portal orders.",
      });
    }
    return requested;
  }
  const d = portal.portalDefault;
  return d === "ROUTE" || d === "SHIP" ? d : undefined;
}
