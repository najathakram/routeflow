import { getTierPrice, isSpecialTier } from "@routeflow/pricing";
import type { SaleLine } from "./counter-sale-scan";

/**
 * POS-2 (DISPLAY ONLY): re-prices the counter cart's lines for the customer now on the sale, the way Create Order prices a
 * line for a customer: the tier is the customer's per-product CustomerPrice tier, else their default tier, and the price is
 * `getTierPrice` of the line's tier-column snapshot at that tier. The sale request never carries these prices (the server
 * prices at create from the same rule), so nothing here can record a staff price override.
 *
 * A line the clerk priced by hand (`priceEdited`) is never overwritten; a line without a snapshot (held before this existed)
 * is left alone. `kept` counts the edited lines whose price the customer's tier WOULD have changed.
 */
export interface RepriceResult {
  lines: SaleLine[];
  changed: number;
  kept: number;
}

export function repriceLines(
  lines: readonly SaleLine[],
  tierFor: (productId: string) => number,
): RepriceResult {
  let changed = 0;
  let kept = 0;
  const next = lines.map((l) => {
    if (!l.tierPrices) return l;
    const tier = tierFor(l.productId);
    const unitPrice = getTierPrice(l.tierPrices, tier);
    const priceType = isSpecialTier(tier) ? ("SPECIAL" as const) : ("STANDARD" as const);
    if (l.unitPrice === unitPrice && l.priceType === priceType) return l;
    if (l.priceEdited) {
      kept += 1;
      return l;
    }
    changed += 1;
    return { ...l, unitPrice, priceType };
  });
  return { lines: changed ? next : (lines as SaleLine[]), changed, kept };
}

/** The inline note after a re-price (names the price tier applied); null when nothing changed and nothing was kept. */
export function repriceNote(
  name: string,
  changed: number,
  kept: number,
  tierName?: string,
): string | null {
  const keptText = kept === 1 ? "1 line kept its price." : `${kept} lines kept their prices.`;
  const who = tierName ? `${name} (${tierName})` : name;
  if (changed > 0)
    return kept > 0 ? `Prices updated for ${who}. ${keptText}` : `Prices updated for ${who}.`;
  return kept > 0 ? keptText : null;
}
