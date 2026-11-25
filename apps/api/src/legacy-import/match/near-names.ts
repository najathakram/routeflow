import type { CatalogItemRow, ItemSuggestion, NearNameGroup } from "./types";

export function groupNearNames(_names: string[]): NearNameGroup[] {
  return [];
}

export function suggestNearNames(
  _name: string,
  _catalog: CatalogItemRow[],
  _limit = 5,
): ItemSuggestion[] {
  return [];
}
