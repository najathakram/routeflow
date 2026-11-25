import type { CatalogItemRow, ItemAliasRow, ItemMatchResult } from "./types";

export function resolveItem(
  name: string,
  _catalog: CatalogItemRow[],
  _aliases: ItemAliasRow[],
): ItemMatchResult {
  return { kind: "UNMATCHED", sourceKey: name, productId: null, ignore: false, suggestions: [] };
}
