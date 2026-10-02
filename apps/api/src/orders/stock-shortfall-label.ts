/**
 * Display-only helper for the coded INSUFFICIENT_STOCK / Not-enough-stock bodies. It reads the live
 * product's pack ONLY to choose the noun for a shortfall line; it derives no line factor, quantity
 * or price and writes nothing, so it is a named non-line helper (line-units-callsites NON_WRITERS).
 */

/**
 * The unit noun for a stock-shortfall line. `available`/`requested` count PIECES, and for a boxed
 * product `Product.unit` names the PACK ("Box", "case"), so sending it would make "Only 10 Box"
 * overstate stock by unitsPerBox. Only when the product is not packed (unitsPerBox null or <= 1)
 * is `unit` the piece unit; otherwise omit it and clients say "pieces".
 */
export function pieceUnitLabel(p: {
  unit?: string | null;
  unitsPerBox?: unknown;
}): string | undefined {
  const upb = p.unitsPerBox == null ? null : Number(p.unitsPerBox);
  if (upb != null && upb > 1) return undefined;
  return p.unit ?? undefined;
}
