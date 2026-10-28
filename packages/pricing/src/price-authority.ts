/**
 * Who sets a product's price? One pure answer for every writer and reader, so the grid, the unit
 * writers, the product editor and the family editor can never disagree.
 *
 * - "own"         the product's own row carries the price; a write is accepted.
 * - "family"      the family product carries it; a write to this product is refused (409).
 * - "family-page" a FAMILY product itself; its prices are edited on the family page.
 *
 * `level` is "base" for a write to the product's five price columns (or a unit row whose
 * factorToBase is 1) and "other" for every other unit level — a tenant's Case, pallet or any
 * sub-unit is the tenant's to price.
 */
export type PriceAuthorityMode = "on" | "off";
export type PriceAuthorityLevel = "base" | "other";
export type PriceAuthorityKind = "STANDARD" | "FAMILY" | "VARIANT" | "RECIPE";
export type PriceAuthority = "own" | "family" | "family-page";

export interface PriceAuthorityProduct {
  kind: PriceAuthorityKind | string | null | undefined;
  parentProductId?: string | null;
  familyPriceOverride?: boolean | null;
  /** The family a RECIPE product's latest recipe links to; callers fill it only for a RECIPE
   * without the override in mode "on", else null. */
  recipeFamilyId?: string | null;
}

export function priceAuthority(
  product: PriceAuthorityProduct,
  mode: PriceAuthorityMode,
  level: PriceAuthorityLevel,
): PriceAuthority {
  const kind: PriceAuthorityKind | string | null | undefined = product.kind;
  switch (kind) {
    case "FAMILY":
      return "family-page";
    case "STANDARD":
    case "VARIANT":
    case "RECIPE":
      return ownedBelowFamily(product, kind, mode, level);
    default:
      return ownedBelowFamily(product, "STANDARD", mode, level);
  }
}

function ownedBelowFamily(
  product: PriceAuthorityProduct,
  kind: Exclude<PriceAuthorityKind, "FAMILY">,
  mode: PriceAuthorityMode,
  level: PriceAuthorityLevel,
): PriceAuthority {
  if (mode === "off" || level === "other") return "own";
  switch (kind) {
    case "STANDARD":
    case "VARIANT":
      return product.parentProductId ? "family" : "own";
    case "RECIPE":
      if (product.parentProductId) return "family";
      return !product.familyPriceOverride && product.recipeFamilyId ? "family" : "own";
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}
