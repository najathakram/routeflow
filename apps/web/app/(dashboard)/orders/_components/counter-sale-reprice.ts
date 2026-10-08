import { getTierPrice, isSpecialTier, withinStaffOverrideTolerance } from "@routeflow/pricing";
import { resolveCounterPriceEdit } from "@/lib/counter-price-edit";
import type { SaleLine } from "./counter-sale-scan";

/**
 * POS-2 (DISPLAY ONLY): re-prices the counter cart's lines for the customer now on the sale, the way Create Order prices a
 * line for a customer: the tier is the customer's per-product CustomerPrice tier, else their default tier, and the price is
 * `getTierPrice` of the line's tier-column snapshot at that tier. The sale request never carries these prices (the server
 * prices at create from the same rule), so nothing here can record a staff price override.
 *
 * A line edited by PERCENT or DOLLARS OFF (R17-3) has that same edit re-applied to the new customer's price; a line the
 * clerk priced by hand (`priceEdited`, mode "set") keeps its NET price as typed (so does an edit the new customer cannot
 * take) while its `tierPrice` (the struck "was" figure) follows the new customer; a net that now equals the new tier price (within 1/2
 * cent) is no override and the line becomes a plain line again. A line without a snapshot (held before this existed) is left
 * alone. `kept` counts the edited lines whose tier price the customer WOULD have changed; an edited line whose net
 * stands and only whose STANDARD/SPECIAL flag moved is updated silently and is NOT counted as kept.
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
  let touched = false;
  const next = lines.map((l) => {
    if (!l.tierPrices) return l;
    const tier = tierFor(l.productId);
    const unitPrice = getTierPrice(l.tierPrices, tier);
    const priceType = isSpecialTier(tier) ? ("SPECIAL" as const) : ("STANDARD" as const);
    if (l.override) {
      // R17-3: a percent or dollars-off edit is RE-APPLIED to the new customer's price; a hand-typed price (mode "set"),
      // or an edit this customer cannot take (over their price, a special tier with no reason), keeps its net.
      let net = l.unitPrice;
      if (l.override.mode !== "set") {
        const again = resolveCounterPriceEdit(
          l.override.mode,
          l.override.value,
          {
            tierPrice: unitPrice,
            listPrice: l.listPrice ?? unitPrice,
            tier,
            qty: l.qty,
            boxes: l.boxes,
            pieces: l.pieces,
            unitsPerBox: l.unitsPerBox,
          },
          l.override.reason,
        );
        if (again.ok) net = again.unitPrice;
      }
      if (withinStaffOverrideTolerance(net, unitPrice)) {
        // POS-5: the net now IS the customer's price: no override, a plain line.
        const { override: _o, tierPrice: _t, priceEdited: _e, ...plain } = l;
        changed += 1;
        return { ...plain, unitPrice, priceType };
      }
      if (net !== l.unitPrice) {
        changed += 1; // the edit followed the customer: updated, not kept
        return { ...l, unitPrice: net, tierPrice: unitPrice, priceType };
      }
      if ((l.tierPrice ?? l.unitPrice) === unitPrice) {
        if (l.priceType === priceType) return l;
        // Only the STANDARD/SPECIAL flag moved (the tier price did not): not a kept price, nothing to tell the clerk.
        touched = true;
        return { ...l, priceType };
      }
      kept += 1;
      return { ...l, tierPrice: unitPrice, priceType };
    }
    if (l.unitPrice === unitPrice && l.priceType === priceType) return l;
    if (l.priceEdited) {
      if (l.unitPrice === unitPrice) {
        // The net stands and equals the tier price: only the flag moved, so it is updated silently.
        touched = true;
        return { ...l, priceType };
      }
      kept += 1;
      return l;
    }
    changed += 1;
    return { ...l, unitPrice, priceType };
  });
  return { lines: changed || kept || touched ? next : (lines as SaleLine[]), changed, kept };
}

/**
 * The inline note after a re-price (names the price tier applied); null when nothing changed and nothing was kept.
 * "Prices updated for <who>." always comes first; the "{n} edited price(s) kept." clause follows it.
 */
export function repriceNote(
  name: string,
  changed: number,
  kept: number,
  tierName?: string,
): string | null {
  const keptText = kept === 1 ? "1 edited price kept." : `${kept} edited prices kept.`;
  const who = tierName ? `${name} (${tierName})` : name;
  if (changed === 0 && kept === 0) return null;
  const updated = `Prices updated for ${who}.`;
  return kept > 0 ? `${updated} ${keptText}` : updated;
}
