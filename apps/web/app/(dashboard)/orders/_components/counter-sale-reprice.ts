import {
  customerLinePrice,
  withinStaffOverrideTolerance,
  type CustomerLayerUnit,
} from "@routeflow/pricing";
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
 *
 * S19b (SA-811a): `layerOf` (flag on, the customer's price layer) puts a layered product on the customer's price through
 * `customerLinePrice`; with no layer for a product (flag off: `layerOf` omitted) the price is master's `getTierPrice`.
 */
export interface RepriceResult {
  lines: SaleLine[];
  changed: number;
  kept: number;
  /** Discounts removed because they were larger than the new customer's price (also counted in `changed`). */
  dropped: number;
}

export function repriceLines(
  lines: readonly SaleLine[],
  tierFor: (productId: string) => number,
  layerOf?: (productId: string) => readonly CustomerLayerUnit[] | undefined,
): RepriceResult {
  let changed = 0;
  let kept = 0;
  let dropped = 0;
  let touched = false;
  const next = lines.map((l) => {
    if (!l.tierPrices) return l;
    const tier = tierFor(l.productId);
    const lp = customerLinePrice({
      product: l.tierPrices as Record<string, unknown>,
      tier,
      layer: layerOf?.(l.productId),
    });
    const unitPrice = lp.price;
    const priceType = lp.isSpecial ? ("SPECIAL" as const) : ("STANDARD" as const);
    if (l.override) {
      // R17-3: a percent or dollars-off edit is RE-APPLIED to the new customer's price; a hand-typed price (mode "set"),
      // or an edit this customer cannot take (over their price, a special tier with no reason), keeps its net.
      let net = l.unitPrice;
      let reapplied = false;
      if (l.override.mode !== "set") {
        const again = resolveCounterPriceEdit(
          l.override.mode,
          l.override.value,
          {
            tierPrice: unitPrice,
            listPrice: l.listPrice ?? unitPrice,
            tier,
            ...(lp.layered ? { isSpecial: lp.isSpecial } : {}),
            qty: l.qty,
            boxes: l.boxes,
            pieces: l.pieces,
            unitsPerBox: l.unitsPerBox,
          },
          l.override.reason,
        );
        if (again.ok) {
          net = again.unitPrice;
          reapplied = true;
        } else if (again.refused === "AMOUNT_OVER_PRICE") {
          // The dollars off are bigger than this customer's price: the edit is DROPPED (never carried over from the
          // previous customer's figure), the line takes the customer's own price, and the note says so.
          const { override: _o, tierPrice: _t, priceEdited: _e, ...plain } = l;
          changed += 1;
          dropped += 1;
          return { ...plain, unitPrice, priceType };
        }
      }
      if (withinStaffOverrideTolerance(net, unitPrice)) {
        // POS-5: the net now IS the customer's price: no override, a plain line.
        const { override: _o, tierPrice: _t, priceEdited: _e, ...plain } = l;
        changed += 1;
        return { ...plain, unitPrice, priceType };
      }
      if (reapplied && (net !== l.unitPrice || (l.tierPrice ?? l.unitPrice) !== unitPrice)) {
        // The edit was re-applied to this customer's price: updated, not kept, even when the figure lands on the same net.
        changed += 1;
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
  // S19b: keep `special` (the layer's isSpecial) in step with the layer; absent when the layer does not price the line.
  let flagMoved = false;
  const flagged = next.map((l) => {
    if (!l.tierPrices) return l;
    const lp = customerLinePrice({
      product: l.tierPrices as Record<string, unknown>,
      tier: tierFor(l.productId),
      layer: layerOf?.(l.productId),
    });
    const want = lp.layered ? lp.isSpecial : undefined;
    if (l.special === want) return l;
    flagMoved = true;
    const { special: _s, ...rest } = l;
    return want === undefined ? rest : { ...rest, special: want };
  });
  return {
    lines: changed || kept || touched || flagMoved ? flagged : (lines as SaleLine[]),
    changed,
    kept,
    dropped,
  };
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
  dropped = 0,
): string | null {
  const keptText = kept === 1 ? "1 edited price kept." : `${kept} edited prices kept.`;
  const droppedText =
    dropped === 1
      ? "Discount removed — it was larger than this customer's price."
      : `${dropped} discounts removed — they were larger than this customer's price.`;
  const who = tierName ? `${name} (${tierName})` : name;
  if (changed === 0 && kept === 0) return null;
  const updated = `Prices updated for ${who}.`;
  return [updated, kept > 0 ? keptText : "", dropped > 0 ? droppedText : ""]
    .filter(Boolean)
    .join(" ");
}
