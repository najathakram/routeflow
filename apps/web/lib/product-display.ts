/**
 * Compose the display name for a Product the way users want to see it on
 * invoices, orders, line items, and any other customer-facing surface.
 *
 * Background: PR #44 stopped baking the parent name into a variant's
 * `name` column. Variants now store JUST the variant name (e.g.
 * "Strawberry"). That keeps the parent's own name clean ("Geek Next 50K"),
 * and lets the same flavor name coexist under different parents (PR #52).
 * The trade-off is that anywhere we would have shown `product.name` and
 * gotten "Geek Next 50K - Strawberry" for free, we now show just
 * "Strawberry" — which is meaningless on its own on an invoice line.
 *
 * This helper closes that gap: when the product is a variant, it composes
 * "<parent name> - <variant name>". For standalone products it returns
 * `name` unchanged.
 *
 *   - product.parent.name is used when the API populated it (true for
 *     /products/barcode/:code and any include({ parent: true })).
 *   - Otherwise we look up parentProductId in `allProducts` if provided.
 *   - Last resort, fall back to `product.name`.
 */
export interface DisplayProductLike {
  name: string;
  variantName?: string | null;
  parentProductId?: string | null;
  parent?: { name: string } | null;
}

const SEPARATOR = " - ";

export function displayProductName(
  product: DisplayProductLike,
  allProducts?: ReadonlyArray<{ id: string; name: string }>,
): string {
  // Standalone product (no parent linkage) → its name IS the display name.
  if (!product.parentProductId && !product.parent) {
    return product.name;
  }

  const variantPart = (product.variantName ?? product.name).trim();
  if (!variantPart) return product.name;

  // Resolve parent name from the eagerly-loaded relation, then from the
  // optional lookup table the caller may have on hand.
  let parentName: string | null = null;
  if (product.parent?.name) {
    parentName = product.parent.name;
  } else if (product.parentProductId && allProducts) {
    const found = allProducts.find((p) => p.id === product.parentProductId);
    parentName = found?.name ?? null;
  }

  if (!parentName) {
    // Don't have parent context — return the variant name unprefixed; the
    // caller's UI will look the same as it did before this helper.
    return variantPart;
  }

  // Defensive: if the stored variant name accidentally already starts with
  // the parent prefix (e.g. legacy rows from before PR #44), don't double
  // up "<Parent> - <Parent> - <Variant>".
  const prefix = `${parentName}${SEPARATOR}`;
  if (variantPart.toLowerCase().startsWith(prefix.toLowerCase())) {
    return variantPart;
  }

  return `${parentName}${SEPARATOR}${variantPart}`;
}
