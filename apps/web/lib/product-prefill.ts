export type PrefillDoor = "typed" | "scanBox" | "camera";

/**
 * W-1042: what the new-product window starts with from text the clerk typed or scanned. The door decides, not the digits:
 * - "typed" (default; Create Order's typed row, the counter's Create "text"): six or more digits is a SKU, anything else a name.
 * - "scanBox" (a miss from the scan box, where a wedge and a typed Enter are one path): no space and at least one digit is
 *   a SKU, otherwise a name.
 * - "camera": a machine read, always a SKU whatever its characters.
 */
export function newProductPrefill(
  text: string,
  from: PrefillDoor = "typed",
): { name: string; sku: string } {
  const t = text.trim();
  const isSku =
    from === "camera" ? true : from === "scanBox" ? /^\S*\d\S*$/.test(t) : /^\d{6,}$/.test(t);
  return isSku ? { name: "", sku: t } : { name: text, sku: "" };
}
