import { Prisma } from "@prisma/client";

/**
 * Pure weighted-average / lot-costing helpers.
 *
 * COST DISCIPLINE (mirror of the money discipline in `@routeflow/pricing`):
 * unit costs live in Decimal(10, 4) columns, so every cost produced here is
 * `Prisma.Decimal` math clamped to 4dp via {@link costDecimal} — never `Number`
 * float arithmetic. Convert to a 2dp money value (valuation totals, COGS in
 * API responses) only at the response boundary, via `roundMoney`.
 *
 * All inventory writers (manual purchase, PO receive, vendor-bill receive,
 * sales, cost-basis edits, recompute) must go through these helpers so the
 * average-cost rules stay identical everywhere:
 *  - stock <= 0  ⇒ the next purchase RESETS the average to its unit cost;
 *  - reversals are the exact algebraic inverse, but NEVER zero the average
 *    when stock empties — `null` means "keep the previous average".
 */

export const COST_DP = 4;

/** Clamp any numeric input to a 4dp Decimal (half-up). */
export function costDecimal(n: Prisma.Decimal | number | string): Prisma.Decimal {
  return new Prisma.Decimal(n).toDecimalPlaces(COST_DP, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Weighted average after receiving `qty` units at `unitCost`:
 * `(currentStock × currentAvg + qty × unitCost) / (currentStock + qty)`.
 * Zero/negative stock resets the average to the incoming unit cost.
 */
export function nextAverageCost(
  currentStock: Prisma.Decimal,
  currentAvg: Prisma.Decimal | null,
  qty: Prisma.Decimal,
  unitCost: Prisma.Decimal,
): Prisma.Decimal {
  if (currentStock.lte(0)) return costDecimal(unitCost);
  const avg = currentAvg ?? new Prisma.Decimal(0);
  return costDecimal(currentStock.mul(avg).add(qty.mul(unitCost)).div(currentStock.add(qty)));
}

/**
 * Exact inverse of {@link nextAverageCost} — the average the product had
 * BEFORE `qty` units at `unitCost` were received. Returns `null` when the
 * reversal empties (or overshoots) stock or would produce a negative average:
 * callers must then KEEP the previous average rather than zeroing it, so the
 * cost basis survives a revert/void that drains stock.
 */
export function reverseAverageCost(
  currentStock: Prisma.Decimal,
  currentAvg: Prisma.Decimal,
  qty: Prisma.Decimal,
  unitCost: Prisma.Decimal,
): Prisma.Decimal | null {
  const stockAfter = currentStock.sub(qty);
  if (stockAfter.lte(0)) return null;
  const numerator = currentStock.mul(currentAvg).sub(qty.mul(unitCost));
  if (numerator.lt(0)) return null;
  return costDecimal(numerator.div(stockAfter));
}

export interface LotLike {
  id: string;
  remainingQty: Prisma.Decimal;
  unitCost: Prisma.Decimal;
}

export interface LotConsumptionPlan {
  /** Per-lot draw-downs, in the order the lots were supplied (FIFO/LIFO is the caller's sort). */
  consumptions: { id: string; take: Prisma.Decimal }[];
  /** Blended cost of the whole quantity, uncovered remainder priced at the fallback. */
  weightedUnitCost: Prisma.Decimal;
  /** Quantity not covered by any lot (negative-stock / missing-lot case). */
  uncovered: Prisma.Decimal;
}

/**
 * Plan how `qty` units are drawn from `lots` (already sorted by the caller —
 * `purchaseDate asc` for FIFO, `desc` for LIFO) and what the blended unit cost
 * of the sale is. Pure: performs no writes.
 */
export function planLotConsumption(
  lots: LotLike[],
  qty: Prisma.Decimal,
  fallbackUnitCost: Prisma.Decimal,
): LotConsumptionPlan {
  const consumptions: { id: string; take: Prisma.Decimal }[] = [];
  let remaining = new Prisma.Decimal(qty);
  let costAccum = new Prisma.Decimal(0);

  for (const lot of lots) {
    if (remaining.lte(0)) break;
    const available = new Prisma.Decimal(lot.remainingQty);
    if (available.lte(0)) continue;
    const take = remaining.lte(available) ? remaining : available;
    consumptions.push({ id: lot.id, take });
    costAccum = costAccum.add(take.mul(lot.unitCost));
    remaining = remaining.sub(take);
  }

  const uncovered = remaining.gt(0) ? remaining : new Prisma.Decimal(0);
  if (uncovered.gt(0)) costAccum = costAccum.add(uncovered.mul(fallbackUnitCost));

  const weightedUnitCost = qty.gt(0)
    ? costDecimal(costAccum.div(qty))
    : costDecimal(fallbackUnitCost);

  return { consumptions, weightedUnitCost, uncovered };
}
