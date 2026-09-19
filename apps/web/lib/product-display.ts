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

/** The one true separator between a parent name and a variant name. */
export const PRODUCT_NAME_SEPARATOR = " - ";

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
  const prefix = `${parentName}${PRODUCT_NAME_SEPARATOR}`;
  if (variantPart.toLowerCase().startsWith(prefix.toLowerCase())) {
    return variantPart;
  }

  return `${parentName}${PRODUCT_NAME_SEPARATOR}${variantPart}`;
}

/**
 * Where a row may break a long product name (display only — never derive or store data from it).
 * The catalog convention is "<family> - <distinguishing part>" (`PRODUCT_NAME_SEPARATOR`), e.g.
 * "Sample Pod - Strawberry Banana - 5ct". `stem` is the shared family and may be clamped;
 * `anchor` is everything after the FIRST separator — the flavor / pack size a picker tells two
 * SKUs apart by — and must never be clamped. A name with no separator has no stem: the whole
 * string is the anchor and the caller clamps it as a plain name.
 *
 * (order-ui-redesign-spec §3.2 words this as "the last segment", but its own §3.3 mockup keeps
 * "BERRY BLAST SATIVA - 20CT" together as the anchor; splitting at the first separator is the
 * reading that keeps both the flavor and the pack size unclamped.)
 */
export function splitProductName(name: string): { stem: string | null; anchor: string } {
  const at = name.indexOf(PRODUCT_NAME_SEPARATOR);
  if (at <= 0) return { stem: null, anchor: name };
  const stem = name.slice(0, at).trim();
  const anchor = name.slice(at + PRODUCT_NAME_SEPARATOR.length).trim();
  if (!stem || !anchor) return { stem: null, anchor: name };
  return { stem, anchor };
}
