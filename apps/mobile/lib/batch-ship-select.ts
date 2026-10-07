import { BATCH_SHIP_MAX_ORDERS } from "@routeflow/types";

/**
 * Pure decisions for the operator orders list's multi-select bar (#3168). Kept out of the screen so
 * they are unit-tested (mobile tests are pure-logic Jest).
 */

/**
 * Select mode is offered wherever a bulk action exists: "Plan trip" needs delivery access, batch ship
 * + packing slips need SHIP in the tenant's fulfilment methods (owner ruling: ungated by plan). A
 * ship-only tenant therefore still gets Select, but never "Plan trip".
 */
export function orderSelectControls(f: { deliveryEnabled: boolean; offersShip: boolean }): {
  showSelect: boolean;
  showPlanTrip: boolean;
} {
  return { showSelect: f.deliveryEnabled || f.offersShip, showPlanTrip: f.deliveryEnabled };
}

/** The API refuses a batch over BATCH_SHIP_MAX_ORDERS (400), so the client blocks it up front. */
export function batchShipLimit(count: number): { tooMany: boolean; message: string | null } {
  const tooMany = count > BATCH_SHIP_MAX_ORDERS;
  return {
    tooMany,
    message: tooMany ? `Select up to ${BATCH_SHIP_MAX_ORDERS} orders to ship at once` : null,
  };
}

/**
 * The selected ids that are in the loaded/visible list, in list order. A filter or search change can
 * leave ids selected that are no longer on screen; the user never sees those, so they must not be
 * sent to a ship / print request.
 */
export function visibleSelectedIds(selected: ReadonlySet<string>, visibleIds: string[]): string[] {
  return visibleIds.filter((id) => selected.has(id));
}
