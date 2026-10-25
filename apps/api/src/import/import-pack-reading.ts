import type { PackReading } from "../products/pack-intro";

/**
 * The reading the product import gives a pack size it sets on a product that had none (SA-946 MUST 3,
 * amended by SA-961 section 1, R1). "piece" = no conversion: stock, reorder levels, cost and open lots stay
 * as stored. Stored stock of such a product is in no single unit (boxes or pieces, entered product by
 * product), so a multiply would overstate it N-fold and fail open; stock is put right by a physical count
 * after the import. The helper keeps the "box" reading for the product editor, where a person answers for
 * one product.
 */
export const IMPORT_PACK_READING: PackReading = "piece";

/** Row warning (SA-961 R1): informational, shown in the dry run; nothing is blocked or written. */
export const PACK_COST_ABOVE_PIECE_WARNING =
  "Cost is above the price per piece (price divided by units per box), so it looks like a cost per box. Correct it in the product editor or with the next purchase.";

/** `changes` plus the import's pack reading whenever the row writes a pack size; otherwise `changes` as is. */
export function withImportPackReading<T extends { unitsPerBox?: unknown }>(
  changes: T,
): T & { packReading?: PackReading } {
  return changes.unitsPerBox === undefined
    ? changes
    : { ...changes, packReading: IMPORT_PACK_READING };
}
