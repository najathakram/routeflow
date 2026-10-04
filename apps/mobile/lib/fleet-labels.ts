/**
 * Mobile fleet-OFF (owner ruling 2026-10-04 — operator side only). A tenant with NEITHER fleet module
 * (`recurring_routes`, `order_delivery`) has its fleet surfaces HIDDEN (`isFleetOff`). The "Shipped" labels
 * are a separate axis: `isShipMode` (fulfilment_model === "ship"). LABELS AND GATES ONLY — order statuses and their transitions
 * are never changed here. Pure (no react-query / api-client imports) so mobile's node-only Jest can pin it.
 */

export const fleetShippedLabel = "Shipped";

interface ModuleAccess {
  enabled: boolean;
  /** The addons read landed (success). While false the answer is unknown. */
  resolved: boolean;
}

/**
 * True only when BOTH modules are POSITIVELY resolved as off. Fails OPEN on unknown (loading / offline /
 * 5xx), exactly like `(operator)/_layout.tsx`: never hide a fleet surface on an answer we do not have.
 */
export function isFleetOff(routes: ModuleAccess, delivery: ModuleAccess): boolean {
  return routes.resolved && delivery.resolved && !routes.enabled && !delivery.enabled;
}

/**
 * SHIPPING semantics key ONLY on the tenant's `modes.fulfilment_model === "ship"` (SA-649 R3) — NEVER on
 * fleet-off. An unset mode (or still loading / unknown) with fleet off must look exactly like today.
 */
export function isShipMode(modes?: Record<string, string> | null): boolean {
  return modes?.fulfilment_model === "ship";
}

/** The label for an order status: the out-the-door status reads "Shipped" in ship mode. */
export function shipStatusLabel(status: string, baseLabel: string, shipMode: boolean): string {
  return shipMode && status === "OUT_FOR_DELIVERY" ? fleetShippedLabel : baseLabel;
}

/** Orders-list status chip labels that depend on fleet (every other chip is fleet-independent). */
export const STATUS_FILTER_LABELS = {
  OUT_FOR_DELIVERY: (shipMode: boolean) => (shipMode ? fleetShippedLabel : "Out"),
} as const;
