import { itemSourceKey, normalizeItemName } from "./normalize-item-name";
import { suggestNearNames } from "./near-names";
import type { CatalogItemRow, ItemAliasRow, ItemMatchResult, ItemSuggestion } from "./types";

function result(
  kind: ItemMatchResult["kind"],
  sourceKey: string,
  extra: Partial<ItemMatchResult> = {},
): ItemMatchResult {
  return { kind, sourceKey, productId: null, ignore: false, suggestions: [], ...extra };
}

function asSuggestions(rows: CatalogItemRow[]): ItemSuggestion[] {
  return rows.map((r) => ({ productId: r.id, name: r.name, score: 1 }));
}

/**
 * Order: exact alias, exact catalog name, normalised catalog name, near-name suggestions,
 * else unmatched. Only the first three can set a product, and only when they name exactly one.
 * Everything else leaves `productId` null: a near name is a suggestion for a person to confirm.
 */
export function resolveItem(
  name: string,
  catalog: CatalogItemRow[],
  aliases: ItemAliasRow[],
): ItemMatchResult {
  const sourceKey = itemSourceKey(name);

  const alias = aliases.find(
    (a) => a.sourceItemKey === sourceKey && (a.ignore || a.productId !== null),
  );
  if (alias) {
    return result("ALIAS", sourceKey, {
      productId: alias.ignore ? null : alias.productId,
      ignore: alias.ignore,
    });
  }

  const exact = catalog.filter((c) => c.name.trim() === sourceKey);
  if (exact.length === 1) return result("EXACT", sourceKey, { productId: exact[0].id });
  if (exact.length > 1)
    return result("AMBIGUOUS", sourceKey, { suggestions: asSuggestions(exact) });

  const key = normalizeItemName(sourceKey);
  const normalised = key === "" ? [] : catalog.filter((c) => normalizeItemName(c.name) === key);
  if (normalised.length === 1) {
    return result("NORMALISED", sourceKey, { productId: normalised[0].id });
  }
  if (normalised.length > 1) {
    return result("AMBIGUOUS", sourceKey, { suggestions: asSuggestions(normalised) });
  }

  const suggestions = suggestNearNames(sourceKey, catalog);
  return suggestions.length > 0
    ? result("SUGGESTED", sourceKey, { suggestions })
    : result("UNMATCHED", sourceKey);
}
