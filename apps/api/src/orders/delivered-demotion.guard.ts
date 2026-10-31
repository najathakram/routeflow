import { ConflictException } from "@nestjs/common";
import { assertWalkInSaleNotReopened } from "./counter-sale/walk-in-sale-lock";

type DemotionReader = Parameters<typeof assertWalkInSaleNotReopened>[0] & {
  routeRunStop: { findUnique(args: unknown): Promise<{ status: string } | null> };
};

/**
 * Reopening a delivered order (DELIVERED -> CONFIRMED / PARTIALLY_DELIVERED) from the status path. The caller runs
 * this on the demotion only. Two refusals, in order:
 * 1. A paid walk-in sale stays closed: the walk-in holds no receivable, so a reopened order could never be collected.
 * 2. A route-delivered order would leave its run stop COMPLETED while the order says otherwise. The stop owns the
 *    stock and payment reversal, so staff are sent there instead. One extra lookup, and only when a stop is linked.
 */
export async function assertDeliveredDemotionAllowed(
  db: DemotionReader,
  order: { id: string; routeRunStopId: string | null },
): Promise<void> {
  await assertWalkInSaleNotReopened(db, order.id);
  if (!order.routeRunStopId) return;
  const stop = await db.routeRunStop.findUnique({
    where: { id: order.routeRunStopId },
    select: { status: true },
  });
  if (stop?.status === "COMPLETED") {
    throw new ConflictException(
      "This order was delivered on a route run. Reopen its stop from the run instead — that reverses stock and payments correctly.",
    );
  }
}
