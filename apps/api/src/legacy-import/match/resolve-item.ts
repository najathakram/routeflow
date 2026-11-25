import { itemSourceKey, normalizeItemName } from "./normalize-item-name";
import { compareCodePoint, suggestNearNames } from "./near-names";
import type { CatalogItemRow, ItemAliasRow, ItemMatchResult, ItemSuggestion } from "./types";

function result(
  kind: ItemMatchResult["kind"],
  sourceKey: string,
  extra: Partial<ItemMatchResult> = {},
): ItemMatchResult {
  return { kind, sourceKey, productId: null, ignore: false, suggestions: [], ...extra };
}

function asSuggestions(rows: CatalogItemRow[]): ItemSuggestion[] {
  return rows
    .map((r) => ({ productId: r.id, name: r.name, score: 1 }))
    .sort((a, b) => compareCodePoint(a.name, b.name) || compareCodePoint(a.productId, b.productId));
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

  if (sourceKey === "") return result("UNMATCHED", sourceKey);

  const hits = aliases.filter(
    (a) => a.sourceItemKey === sourceKey && (a.ignore || a.productId !== null),
  );
  const outcomes = new Set(hits.map((a) => (a.ignore ? "ignore" : `product:${a.productId}`)));
  if (outcomes.size > 1) {
    const rows = [
      ...new Set(hits.map((a) => a.productId).filter((p): p is string => p !== null)),
    ].map((id) => ({ id, name: catalog.find((c) => c.id === id)?.name ?? "" }));
    return result("AMBIGUOUS", sourceKey, { suggestions: asSuggestions(rows) });
  }
  if (hits.length > 0) {
    const alias = hits[0];
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
