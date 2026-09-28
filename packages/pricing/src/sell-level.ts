/** #2717 M1: the packaging level a barcode scan resolves to when it isn't tied to an existing line. */
export type SellLevel = "BOX" | "UNIT";

/**
 * #2717 M1 (SA-572b Q8, SA-572c QB): the level a scan resolves to when it lands on no existing line — the product's
 * default sell level: unitsPerBox > 1 ⇒ "BOX", else "UNIT". FOR SCAN-LEVEL RESOLUTION ONLY: newLineQty and mobile's add
 * path are deliberately NOT routed through it in M1 (they treat unitsPerBox = 1 as boxed; that divergence is filed separately).
 */
export function defaultSellLevel(p: { unitsPerBox?: number | null }): SellLevel {
  return typeof p.unitsPerBox === "number" && p.unitsPerBox > 1 ? "BOX" : "UNIT";
}

/**
 * SA-572a (i): one code, two levels ⇒ the line's current sell unit if the scan lands on a line already on the document
 * (Case ⇒ BOX, Unit ⇒ UNIT), otherwise the product's default sell level; never a prompt. If the preferred level is not
 * among the code's rows, the code's only/first available level wins. Unused by any scanner in M1 (M4 switches it).
 * #2717 M1.
 */
export function resolveScanLevel(input: {
  lineMode?: "CASE" | "UNIT" | null;
  unitsPerBox?: number | null;
  available: readonly SellLevel[];
}): SellLevel {
  const preferred: SellLevel =
    input.lineMode === "CASE"
      ? "BOX"
      : input.lineMode === "UNIT"
        ? "UNIT"
        : defaultSellLevel({ unitsPerBox: input.unitsPerBox });

  if (input.available.length === 0) return preferred;
  if (input.available.includes(preferred)) return preferred;
  return input.available[0];
}
