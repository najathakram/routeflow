import { BadRequestException, NotFoundException } from "@nestjs/common";

/**
 * Renumber a run's stops. The body is the run's COMPLETE new order (#2135, Opus review): the ids
 * must equal the run's stops (no other run's stop, none missing, none twice) and the numbers must
 * be exactly 1..N, else 400. Every write matches the stop's `routeRunId` as well as its id, so a
 * body can never renumber another run. The run's status and its stops are read INSIDE the
 * transaction, under the run row lock, and a stop that is IN_PROGRESS refuses the reorder: a
 * driver is standing at it. Extracted from RoutesService (size ratchet); runs in the caller's tx.
 *
 * Lock order (#2635, SA-533e): the house order for this family is STOP rows → RouteRun, the order
 * completeStop / completeWithPayment take on a run's last stop (stop → orders → run). So the run's
 * stop rows are locked first, in a deterministic id order, and only then the RouteRun. Locking the
 * run first inverted that order and could deadlock against a last-stop completion.
 */
export async function reorderRunStopsInTx(
  tx: any,
  runId: string,
  order: { id: string; stopNumber: number }[],
): Promise<void> {
  // SA-533h: an undefined id would bind NULL and lock nothing, and the Prisma reads below would drop
  // the undefined key (the tenant's FIRST run, stops and swaps widened across runs). Refuse first.
  if (!runId) throw new Error("#2635: run id missing for the run-stop reorder");
  await tx.$executeRaw`SELECT id FROM "RouteRunStop" WHERE "routeRunId" = ${runId} ORDER BY id FOR UPDATE`;
  await tx.$executeRaw`SELECT id FROM "RouteRun" WHERE id = ${runId} FOR UPDATE`;
  const run = await tx.routeRun.findFirst({ where: { id: runId } });
  if (!run) throw new NotFoundException("Route run not found");
  if (run.status === "IN_PROGRESS" || run.status === "COMPLETED") {
    throw new BadRequestException("Cannot reorder stops on an active or completed route run");
  }
  const allStops: { id: string; stopNumber: number; status?: string }[] =
    await tx.routeRunStop.findMany({
      where: { routeRunId: runId },
      select: { id: true, stopNumber: true, status: true },
    });
  if (allStops.some((s) => s.status === "IN_PROGRESS")) {
    throw new BadRequestException("Cannot reorder stops while a stop is in progress");
  }
  const ids = new Set(order.map((o) => o.id));
  const numbers = new Set(order.map((o) => o.stopNumber));
  const runIds = new Set(allStops.map((s) => s.id));
  const sameIds =
    ids.size === order.length && ids.size === runIds.size && [...ids].every((id) => runIds.has(id));
  const oneToN =
    numbers.size === order.length &&
    order.every(
      (o) => Number.isInteger(o.stopNumber) && o.stopNumber >= 1 && o.stopNumber <= order.length,
    );
  if (!sameIds || !oneToN) {
    throw new BadRequestException(
      "The order must list every stop of this run exactly once, numbered 1 to " + allStops.length,
    );
  }
  // Two passes so the (run, stopNumber) uniqueness never trips mid-renumber: park every stop
  // above the final range, then write the final numbers. Both scoped to this run.
  const offset = allStops.length + order.length + 100;
  for (const s of allStops) {
    await tx.routeRunStop.updateMany({
      where: { id: s.id, routeRunId: runId },
      data: { stopNumber: s.stopNumber + offset },
    });
  }
  for (const { id, stopNumber } of order) {
    await tx.routeRunStop.updateMany({
      where: { id, routeRunId: runId },
      data: { stopNumber },
    });
  }
  // The polyline lives on the parent route but is what this run's map draws — a hand reorder
  // here makes it wrong too. See clearPlannedPolyline.
  await tx.route.update({ where: { id: run.routeId }, data: { plannedPolyline: null } });
}
