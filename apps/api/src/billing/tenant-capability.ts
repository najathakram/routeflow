import type { TenantCapability, FulfilmentMode } from "@routeflow/types";

/** The two keys that make a tenant a delivery operation (the fleet modules). */
export const FLEET_KEYS = ["recurring_routes", "order_delivery"] as const;

/**
 * Business profiles 1A (SA-649 R1): the capability answer. `fleet` is decided by the MODULES
 * alone (the caller passes whether either fleet key is effectively held); the fulfilment mode
 * never turns fleet on or off, it only drives defaults and wording. `unset` -> `fulfilment: null`.
 * A delivery/both mode with no fleet module is `consistent: false`.
 */
export function computeCapability(fleet: boolean, mode: string): TenantCapability {
  const needsFleet = mode === "delivery" || mode === "both";
  const consistent = !(needsFleet && !fleet);
  return {
    fleet,
    fulfilment: mode === "unset" ? null : (mode as FulfilmentMode),
    consistent,
    inconsistentModes: consistent ? [] : ["fulfilment_model"],
  };
}
