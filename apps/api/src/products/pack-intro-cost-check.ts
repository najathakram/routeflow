import { round4 } from "@routeflow/pricing";

/**
 * SA-961 R1 (dry-run, informational): with a pack of `n` the stored cost is per piece, so a cost above
 * the unit price divided by `n` was evidently entered per box. Counted, never written.
 */
export function costAbovePiecePrice(
  p: { pricePerUnit?: unknown; averageCost?: unknown },
  n: number,
): boolean {
  if (!(n > 1) || p.averageCost == null || p.pricePerUnit == null) return false;
  return Number(p.averageCost) > round4(Number(p.pricePerUnit) / n);
}
