import type { CustomerLinePrice } from "@routeflow/pricing";

/** The line fields the layer correction reads and writes (structurally satisfied by the page's line). */
interface LayerCorrectable {
  unitLabel?: string;
  priceEdited?: boolean;
  unitPrice: number;
  listPrice?: number;
  priceType?: string;
  isSpecialPrice?: boolean;
  regularPrice?: number;
  pricing?: { tierPrice: number; listPrice: number; isSpecialTier: boolean };
}

/**
 * S19b (SA-811a): a unit (level) line must carry the customer-layer price, whichever path put it on the ladder price: the
 * default-unit start, a draft restore, or a resolve at Save. `lineFor` is the layer line for the unit (undefined = no layer
 * row, or the line cannot be matched safely). A typed price stands. Idempotent: lines already on the layer price come back
 * as the SAME array, so a state effect over it cannot loop.
 */
export function correctLayerLevelLines<T extends LayerCorrectable>(
  lines: T[],
  lineFor: (line: T) => CustomerLinePrice | undefined,
): T[] {
  let changed = false;
  const next = lines.map((it) => {
    if (!it.unitLabel || it.priceEdited) return it;
    const r = lineFor(it);
    if (!r) return it;
    if (
      r.price === it.unitPrice &&
      r.listPrice === it.listPrice &&
      r.priceType === it.priceType &&
      it.pricing?.tierPrice === r.price &&
      it.pricing?.listPrice === r.listPrice
    )
      return it;
    changed = true;
    const off = r.price !== r.listPrice;
    return {
      ...it,
      unitPrice: r.price,
      listPrice: r.listPrice,
      priceType: r.priceType,
      isSpecialPrice: off,
      regularPrice: off ? r.listPrice : undefined,
      pricing: { tierPrice: r.price, listPrice: r.listPrice, isSpecialTier: r.isSpecial },
    };
  });
  return changed ? next : lines;
}
