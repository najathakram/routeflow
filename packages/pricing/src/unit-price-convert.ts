import { roundMoney } from "./pricing";

/**
 * SA-954 D3: a price re-expressed in another unit is ONE conversion pair, so a mixed-unit figure is built from the
 * real prices and rounded once, at the end.
 *
 * The base unit is the product's factor-1 level: the unit `InvoiceItem.qty` counts (named by `baseLabelOf`).
 * `piecesPerUnit` is a line's own pack from its sale-time snapshot (`salePackOf`), never today's pack.
 */

/**
 * A unit price per base unit, UNROUNDED. null when the pack is unknown, not finite or <= 0 (a line whose pack
 * cannot be read is left out of a converted figure, never guessed), or the price is not finite.
 */
export function pricePerBaseUnit(unitPrice: number, piecesPerUnit: number | null): number | null {
  if (!Number.isFinite(unitPrice)) return null;
  if (piecesPerUnit == null || !Number.isFinite(piecesPerUnit) || piecesPerUnit <= 0) return null;
  return unitPrice / piecesPerUnit;
}

/** A per-base price expressed in a unit of `piecesPerUnit` base units: the only rounding. */
export function priceInUnit(perBase: number, piecesPerUnit: number): number {
  return roundMoney(perBase * piecesPerUnit);
}
