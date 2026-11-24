/**
 * The one rule for a product's display name (SA-1216). A family variant stores only its own label
 * ("Blueberry"), which means nothing alone, so every staff screen shows "<Family> - <Variant>". A
 * standalone product returns its name unchanged. Web and mobile re-export this; the api keeps a twin
 * (`apps/api/src/products/product-display-name.ts`) pinned to it by a parity spec.
 *
 *   - `product.parent.name` is used when the read included the parent.
 *   - Otherwise `parentProductId` is looked up in `allProducts` when the caller has one on hand.
 *   - With no parent context the bare variant name is returned.
 *   - A legacy row whose stored name already starts "<Parent> - " is not doubled.
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
  if (!product.parentProductId && !product.parent) return product.name;

  const variantPart = (product.variantName ?? product.name).trim();
  if (!variantPart) return product.name;

  let parentName: string | null = null;
  if (product.parent?.name) {
    parentName = product.parent.name;
  } else if (product.parentProductId && allProducts) {
    parentName = allProducts.find((p) => p.id === product.parentProductId)?.name ?? null;
  }
  if (!parentName) return variantPart;

  const prefix = `${parentName}${PRODUCT_NAME_SEPARATOR}`;
  if (variantPart.toLowerCase().startsWith(prefix.toLowerCase())) return variantPart;
  return `${prefix}${variantPart}`;
}
