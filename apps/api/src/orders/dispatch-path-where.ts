import { FulfillPath } from "@prisma/client";

/**
 * The ONE place that says which fulfil paths a dispatch reader leaves out (L-167, SA-763r). A PICKUP order
 * (a counter sale, or a POS-mode order handed over at the till) is never loaded on a route or a trip, so
 * every reader that gathers orders for dispatch takes its `fulfillPath` filter from here instead of
 * writing the literal itself. `dispatch-path-literals.spec.ts` fails when a dispatch reader folder
 * carries a PICKUP path literal of its own.
 *
 *  - `route`: the route and run readers (load list, a run's legacy fallback). They gather an order by its
 *    customer, so SHIP stays in (a carrier order keeps its own flow) and PICKUP is out.
 *  - `trips`: the ad-hoc trip pool. SHIP and PICKUP are both out: only ROUTE orders ride a trip.
 */
export const DISPATCH_PATH_WHERE: {
  route: { not: FulfillPath };
  trips: { notIn: FulfillPath[] };
} = {
  route: { not: FulfillPath.PICKUP },
  trips: { notIn: [FulfillPath.SHIP, FulfillPath.PICKUP] },
};

/** True for an order handed over at the till; the in-memory twin of the filters above. */
export function isPickupFulfilment(order: { fulfillPath?: FulfillPath | null }): boolean {
  return order.fulfillPath === FulfillPath.PICKUP;
}
