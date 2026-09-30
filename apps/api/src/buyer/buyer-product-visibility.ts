import type { Prisma } from "@prisma/client";

/**
 * The ONE predicate for "a product a BUYER may see" (L-167: one shared builder, never a
 * call-site copy). For a buyer a portal-hidden product behaves exactly like an inactive one on
 * every product read. A hidden PARENT hides ALL its variants (via parentProductId, independent
 * of `kind`). Past orders/invoices are not product reads and keep showing hidden products;
 * staff paths never use this.
 *
 * `extra` is AND-composed as its own clause, so it can narrow but never override or widen the
 * visibility clauses above it.
 */
export function buyerVisibleProductWhere(
  extra?: Prisma.ProductWhereInput,
): Prisma.ProductWhereInput {
  return {
    AND: [
      { isActive: true },
      { portalVisible: true },
      { OR: [{ parentProductId: null }, { parent: { portalVisible: true } }] },
      ...(extra ? [extra] : []),
    ],
  };
}

/** Thin id-lookup form of the builder. */
export function buyerVisibleProductByIdWhere(id: string): Prisma.ProductWhereInput {
  return buyerVisibleProductWhere({ id });
}

/**
 * In-memory twin of `buyerVisibleProductWhere` for rows already loaded (detail, favorites,
 * replenishment). `parent` is the loaded parent row (only `portalVisible` is read). A missing
 * flag counts as visible so a partial select never hides a product by accident.
 */
export function isBuyerVisibleProduct(p: {
  isActive?: boolean | null;
  portalVisible?: boolean | null;
  parent?: { portalVisible?: boolean | null } | null;
}): boolean {
  return !!p.isActive && p.portalVisible !== false && p.parent?.portalVisible !== false;
}
