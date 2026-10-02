import { BadRequestException, NotFoundException } from "@nestjs/common";

/**
 * Renumber a route TEMPLATE's stops. The body is the route's COMPLETE new order: the ids must equal
 * the route's stops (none from another route, none missing, none twice) and the numbers must be
 * exactly 1..N, else 400. Every write matches the stop's `routeId` as well as its id, so a body can
 * never renumber another route. The route and its stops are read INSIDE the transaction, under the
 * route row lock. Runs in the caller's tx (extracted from RoutesService for its size ratchet).
 *
 * Lock order: the route's STOP rows (deterministic id order), then the Route row. That is the order
 * the route optimizer's batch takes (route-optimization.service.ts: stop updates, then
 * `route.update`) and the same house order as reorderRunStopsInTx (#2635). The caller wraps this in
 * `retryOnTxConflict`, so a residual 40P01 (the optimizer's own stop order is not id-sorted) is
 * retried, never a 500.
 *
 * The stop locks are FOR NO KEY UPDATE, never FOR UPDATE: dispatch (createRun) takes the Route row
 * FOR UPDATE and then INSERTs RouteRunStop rows, whose FK check takes FOR KEY SHARE on each
 * RouteStop. FOR UPDATE conflicts with that, so a reorder holding the stops and waiting on the
 * Route deadlocked against a dispatch holding the Route and needing the stops (and createRun has no
 * retry: a 500). FOR NO KEY UPDATE does not conflict with KEY SHARE, yet still serialises against
 * the optimizer's stopNumber updates (stopNumber is in a unique index, so those take FOR UPDATE).
 */
export async function reorderRouteStopsInTx(
  tx: any,
  routeId: string,
  order: { id: string; stopNumber: number }[],
): Promise<void> {
  // An undefined id would bind NULL and lock nothing (SA-533h): refuse before any query.
  if (!routeId) throw new Error("route id missing for the route-stop reorder");
  await tx.$executeRaw`SELECT id FROM "RouteStop" WHERE "routeId" = ${routeId} ORDER BY id FOR NO KEY UPDATE`;
  await tx.$executeRaw`SELECT id FROM "Route" WHERE id = ${routeId} FOR UPDATE`;
  const route = await tx.route.findFirst({ where: { id: routeId } });
  if (!route) throw new NotFoundException("Route not found");
  const allStops: { id: string; stopNumber: number }[] = await tx.routeStop.findMany({
    where: { routeId },
    select: { id: true, stopNumber: true },
  });
  const ids = new Set(order.map((o) => o.id));
  const numbers = new Set(order.map((o) => o.stopNumber));
  const routeIds = new Set(allStops.map((s) => s.id));
  const sameIds =
    ids.size === order.length &&
    ids.size === routeIds.size &&
    [...ids].every((id) => routeIds.has(id));
  const oneToN =
    numbers.size === order.length &&
    order.every(
      (o) => Number.isInteger(o.stopNumber) && o.stopNumber >= 1 && o.stopNumber <= order.length,
    );
  if (!sameIds || !oneToN) {
    throw new BadRequestException(
      "The order must list every stop of this route exactly once, numbered 1 to " + allStops.length,
    );
  }
  // Two passes so the (route, stopNumber) uniqueness never trips mid-renumber: park every stop above
  // the final range, then write the final numbers. Both scoped to this route.
  const offset = allStops.length + order.length + 100;
  for (const s of allStops) {
    await tx.routeStop.updateMany({
      where: { id: s.id, routeId },
      data: { stopNumber: s.stopNumber + offset },
    });
  }
  for (const { id, stopNumber } of order) {
    await tx.routeStop.updateMany({ where: { id, routeId }, data: { stopNumber } });
  }
  // See clearPlannedPolyline — a hand reorder invalidates the stored path.
  await tx.route.update({ where: { id: routeId }, data: { plannedPolyline: null } });
}
