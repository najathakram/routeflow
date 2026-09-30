import type { Prisma } from "@prisma/client";

/**
 * WS6 / WS8 (SA-606): the ONE "a product that can be sold" predicate — active and NOT a FAMILY container (a
 * FAMILY is non-stocked and non-sellable). Every staff picker and scan resolution composes this; the buyer builder
 * (`buyer/buyer-product-visibility.ts`) imports it, never a copy (L-167). `extra` is AND-composed as its own clause, so
 * it can narrow but never widen.
 */
export function sellableProductWhere(extra?: Prisma.ProductWhereInput): Prisma.ProductWhereInput {
  return {
    AND: [{ isActive: true }, { kind: { not: "FAMILY" } }, ...(extra ? [extra] : [])],
  };
}

/** In-memory twin for rows already loaded. `kind` is REQUIRED, so a select that forgets it is a compile error. */
export function isSellableProduct(p: { isActive: boolean; kind: string }): boolean {
  return p.isActive && p.kind !== "FAMILY";
}
