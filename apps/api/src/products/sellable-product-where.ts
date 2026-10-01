import type { Prisma } from "@prisma/client";

/**
 * WS6 / WS8 (SA-606): the ONE "a product that can be sold" predicate — active and NOT a FAMILY container (a
 * FAMILY is non-stocked and non-sellable). The buyer builder (`buyer/buyer-product-visibility.ts`) composes it and
 * never keeps a copy (L-167); staff write paths refuse a FAMILY line through `assertSellableLines`
 * (`products/sellable-lines.ts`), which states the same rule for an order/invoice/estimate/PO line. `extra` is AND-composed as its own clause, so
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
