/**
 * H6 (qa-azm 2026-10-13): the buyer catalog's search and category clauses. A family variant stores only its own
 * label ("Classic") and no category of its own, so the staff list's clauses (name/sku/barcode/unitSku contains,
 * category equals) never find it by what a buyer types ("chips") or under its family's category ("Snacks").
 */
const ci = (value: string) => ({ contains: value, mode: "insensitive" as const });

/** Matches the product's own name/codes, its variant label, or its family's name/SKU. */
export function buyerSearchWhere(search: string): Record<string, unknown> {
  return {
    OR: [
      { name: ci(search) },
      { sku: ci(search) },
      { barcode: ci(search) },
      { unitSku: ci(search) },
      { variantName: ci(search) },
      { parent: { name: ci(search) } },
      { parent: { sku: ci(search) } },
    ],
  };
}

/** The product's own category, or (when it has none) its family's. Case-insensitive like the staff list. */
export function buyerCategoryWhere(category: string): Record<string, unknown> {
  const eq = { equals: category, mode: "insensitive" as const };
  return { OR: [{ category: eq }, { category: null, parent: { category: eq } }] };
}
