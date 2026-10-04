// ─── Business profiles 1A — the shared contract ────────────────────────────────────────────
//
// `fulfilment_model` is a free config mode ("how do orders reach your customers?"); `unset` is
// today's behavior for every tenant. The profile shapes (list / preview / apply) land with the
// profiles PR that stacks on this one.

export const FULFILMENT_MODE_VALUES = ["unset", "delivery", "ship", "both", "pickup"] as const;
export type FulfilmentMode = (typeof FULFILMENT_MODE_VALUES)[number];

/**
 * The server-computed capability answer. `fleet` = recurring_routes || order_delivery effective
 * (the modules are the ONLY truth; the mode never turns fleet on or off). `fulfilment` is the
 * effective mode, or `null` when UNSET. `consistent` is false when the mode is delivery|both and
 * `fleet` is false (e.g. a module was denied after the mode was set).
 */
export interface TenantCapability {
  fleet: boolean;
  fulfilment: FulfilmentMode | null;
  consistent: boolean;
  inconsistentModes: string[];
}
