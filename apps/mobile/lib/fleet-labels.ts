/**
 * Mobile fleet-OFF (owner ruling 2026-10-04 — operator side only). A tenant with NEITHER fleet module
 * (`recurring_routes`, `order_delivery`) has no routes, trips or drivers, so the out-the-door order status is a
 * hand-off, not a delivery: it reads "Shipped". LABELS AND GATES ONLY — order statuses and their transitions
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

/** The label for an order status: the out-the-door status reads "Shipped" when fleet is off. */
export function fleetOffStatusLabel(status: string, baseLabel: string, fleetOff: boolean): string {
  return fleetOff && status === "OUT_FOR_DELIVERY" ? fleetShippedLabel : baseLabel;
}

/** Orders-list status chip labels that depend on fleet (every other chip is fleet-independent). */
export const STATUS_FILTER_LABELS = {
  OUT_FOR_DELIVERY: (fleetOff: boolean) => (fleetOff ? fleetShippedLabel : "Out"),
} as const;
