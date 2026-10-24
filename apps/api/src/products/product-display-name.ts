/**
 * H6 (qa-azm 2026-10-13): the API twin of web/mobile `displayProductName`. A family variant stores only its own
 * label in `name`/`variantName` ("Classic"), which means nothing on its own, so every customer-facing read composes
 * "<Parent> - <Variant>". A standalone product returns its name unchanged. Same separator and the same guard against
 * a legacy row whose stored name already carries the parent prefix.
 */
export const PRODUCT_NAME_SEPARATOR = " - ";

export interface DisplayNameProduct {
  name: string;
  variantName?: string | null;
  parentProductId?: string | null;
}

export function productDisplayName(
  product: DisplayNameProduct,
  parentName?: string | null,
): string {
  if (!product.parentProductId) return product.name;
  const variantPart = (product.variantName ?? product.name).trim();
  if (!variantPart) return product.name;
  if (!parentName) return variantPart;
  const prefix = `${parentName}${PRODUCT_NAME_SEPARATOR}`;
  if (variantPart.toLowerCase().startsWith(prefix.toLowerCase())) return variantPart;
  return `${prefix}${variantPart}`;
}

/** A variant with no category of its own sits under its family's category (the family is never a buyer tile). */
export function displayCategory(
  product: { category?: string | null },
  parent?: { category?: string | null } | null,
): string | null {
  return product.category ?? parent?.category ?? null;
}
