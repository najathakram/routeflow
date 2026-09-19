import { roundMoney } from "@routeflow/pricing";
import type { ProductUnitLevel } from "@routeflow/types";

export interface CascadeProposal {
  unitId: string;
  label: string;
  from: number;
  to: number;
}

/**
 * The yes/no prompt (units plan ask 2): when the operator changes one level's explicit tier-1
 * price from `oldPrice` to `newPrice`, every OTHER level that holds an explicit price is offered
 * the same proportional move (`price × newPrice ÷ oldPrice`, one rounding). Levels with no
 * explicit price are derived and follow automatically — they never appear here.
 *
 * Returns [] when there is nothing to propose: no real change, a non-positive old/new price
 * (no ratio to apply), or no other explicit-priced level.
 */
export function proposeCascade(
  units: readonly ProductUnitLevel[],
  editedUnitId: string,
  oldPrice: number | null,
  newPrice: number | null,
): CascadeProposal[] {
  if (oldPrice == null || newPrice == null) return [];
  if (!(oldPrice > 0) || !(newPrice > 0) || oldPrice === newPrice) return [];
  const out: CascadeProposal[] = [];
  for (const u of units) {
    if (u.id === editedUnitId) continue;
    const from = u.price == null ? NaN : Number(u.price);
    if (!(from > 0)) continue;
    const to = roundMoney((from * newPrice) / oldPrice);
    if (to !== from) out.push({ unitId: u.id, label: u.label, from, to });
  }
  return out;
}
