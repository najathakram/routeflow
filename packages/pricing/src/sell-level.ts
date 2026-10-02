/**
 * #2728 M1 follow-up (d, pre-merge BLOCK): the const-array + derived-type pattern the rest of the
 * repo pins its Prisma-mirrored enums with (see apps/api/src/common/enum-parity.spec.ts) — nothing
 * enforced these two values stayed in lockstep with the generated `PackagingLevel` enum until now.
 */
export const SELL_LEVEL_VALUES = ["BOX", "UNIT"] as const;

/** #2717 M1: the packaging level a barcode scan resolves to when it isn't tied to an existing line. */
export type SellLevel = (typeof SELL_LEVEL_VALUES)[number];

/**
 * #2717 M1 (SA-572b Q8, SA-572c QB): the level a scan resolves to when it lands on no existing line — the product's
 * default sell level: unitsPerBox > 1 ⇒ "BOX", else "UNIT". FOR SCAN-LEVEL RESOLUTION ONLY: newLineQty and mobile's add
 * path are deliberately NOT routed through it in M1 (they treat unitsPerBox = 1 as boxed; that divergence is filed separately).
 */
export function defaultSellLevel(p: { unitsPerBox?: number | null }): SellLevel {
  return typeof p.unitsPerBox === "number" && p.unitsPerBox > 1 ? "BOX" : "UNIT";
}

// SA-572a (i) as amended by SA-580: the scan-level resolver (the CODE decides the level) lives in the
// scan package (`resolveScanSellLevel`), which depends on this file's `defaultSellLevel`, one direction only.
