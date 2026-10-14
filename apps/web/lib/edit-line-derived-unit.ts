import type { UnitOption } from "@/lib/unit-options";

/** The order-edit row fields a derived-Piece pick reads and writes (structurally satisfied by `EditItemState`). */
export interface DerivedEditLine {
  qty: number;
  unitsPerBox?: number | null;
  derivedBase?: string;
}

/**
 * Units P0b / SA-728 on the ORDER-EDIT page. A DERIVED Piece (a base option with no price of its own) is the PACK
 * line's pieces: `boxSplit`, `unitsPerBox` = the pack size, `qty` = the piece count, the PACK price, no `unitLabel`.
 * `buildItemUpdates` then sends boxes 0 / pieces N and the server prorates, so the preview ($13.33 for 2 of a
 * $20/3-pack) equals the bill. Selling it as a unit line at the rounded per-piece price read 2 x $6.67 = $13.34.
 *
 * Returns the patch for a derived pick, or for "back to the pack" from a derived Piece (ONE whole pack, the marker
 * gone), or `null` when the pick is neither (the caller keeps its ordinary unit/pack handling).
 */
export function derivedUnitPatch(
  current: DerivedEditLine,
  option: UnitOption,
  refresh: boolean,
): Record<string, unknown> | null {
  if (option.kind === "pack") {
    if (!current.derivedBase) return null;
    return {
      derivedBase: undefined,
      startOnDefaultUnit: false,
      qty: Number(current.unitsPerBox ?? 1),
    };
  }
  if (!option.derived) return null;
  const packPrice = option.derived.packPrice;
  return {
    unitLabel: undefined,
    derivedBase: option.value,
    startOnDefaultUnit: false,
    unitsPerBox: option.derived.n,
    boxSplit: true,
    qty: refresh && current.derivedBase === option.value ? current.qty : 1,
    unitPrice: packPrice,
    basePrice: packPrice,
    overrideReason: undefined,
    reasonBaselinePrice: packPrice,
    priceEdited: false,
  };
}
