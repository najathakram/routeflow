import type { Prisma } from "@prisma/client";

/** The parent facts the sellable rule reads; the buyer builder spreads it into its own parent select. */
export const SELLABLE_PARENT_FIELDS = { isActive: true } as const;

/**
 * WS6 / WS8 (SA-606): the ONE "a product that can be sold" predicate — active, NOT a FAMILY container (a FAMILY is
 * non-stocked and non-sellable) and, for a variant, under an ACTIVE parent family (B1213: a variant is only as live
 * as its family; an archived family hides its variants even if their own flag is still set). The buyer builder
 * (`buyer/buyer-product-visibility.ts`) composes it and never keeps a copy (L-167); staff write paths refuse a FAMILY
 * line through `assertSellableLines` (`products/sellable-lines.ts`), which states the same rule for an
 * order/invoice/estimate/PO line. `extra` is AND-composed as its own clause, so it can narrow but never widen.
 */
export function sellableProductWhere(extra?: Prisma.ProductWhereInput): Prisma.ProductWhereInput {
  return {
    AND: [
      { isActive: true },
      { kind: { not: "FAMILY" } },
      { OR: [{ parentProductId: null }, { parent: SELLABLE_PARENT_FIELDS }] },
      ...(extra ? [extra] : []),
    ],
  };
}

/**
 * In-memory twin for rows already loaded. `kind` and `parent` are REQUIRED (`parent` = the loaded parent, null =
 * standalone), so a select that forgets either is a compile error, never a silently sellable product.
 */
export function isSellableProduct(p: {
  isActive: boolean;
  kind: string;
  parent: { isActive: boolean } | null;
}): boolean {
  // Fail closed: a row that never loaded its parent (undefined) is not sellable, never silently standalone.
  return p.isActive && p.kind !== "FAMILY" && (p.parent === null || p.parent?.isActive === true);
}
