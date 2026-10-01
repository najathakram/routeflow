/**
 * The unit noun for a stock-shortfall line (INSUFFICIENT_STOCK). `available`/`requested` count
 * PIECES, and for a boxed product `Product.unit` names the PACK ("Box", "case"), so sending it
 * would make "Only 10 Box" overstate stock by unitsPerBox. Only when the product is not packed
 * (unitsPerBox null or <= 1) is `unit` the piece unit; otherwise omit it and clients say "pieces".
 *
 * Reads the live pack as a DISPLAY GATE only: it derives no line factor, quantity or price
 * (listed in line-units-callsites.spec.ts NON_WRITERS).
 */
export function pieceUnitLabel(p: {
  unit?: string | null;
  unitsPerBox?: unknown;
}): string | undefined {
  const upb = p.unitsPerBox == null ? null : Number(p.unitsPerBox);
  if (upb != null && upb > 1) return undefined;
  return p.unit ?? undefined;
}
