/**
 * Row 630: the price and size a STORED pack line was sold at, which price its derived Piece (`OrderLineUnitPicker.ownPack`).
 * Undefined for a line added this session, an unlisted line, a stored unit line (its price is per unit, not per pack), or a
 * line with no pack size: those keep the picker's own pricing.
 *
 * DECISION: the basis is the STORED price (`originalUnitPrice`), not the row's current `unitPrice`. A pack price the operator
 * typed this session and has not saved is replaced by the stored price when they pick Piece, because the server re-splits the
 * line at its stored size and price. Pinned by the DECISION test in page.edit-derived-piece-line-price.test.tsx.
 */
export function storedPackBasis(item: {
  isNew?: boolean;
  isUnlisted?: boolean;
  originalUnitLabel?: string;
  originalUnitPrice?: number;
  originalUnitsPerBox?: number | null;
}): { unitPrice: number; unitsPerBox: number } | undefined {
  const upb = Number(item.originalUnitsPerBox ?? 0);
  if (item.isNew || item.isUnlisted || item.originalUnitLabel) return undefined;
  if (item.originalUnitPrice == null || !(upb > 1)) return undefined;
  return { unitPrice: item.originalUnitPrice, unitsPerBox: upb };
}
