import { BadRequestException } from "@nestjs/common";
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

/**
 * Buyer replace-all gate: the first product in `products` that is portal-hidden (own flag or
 * hidden parent) and that the order does not already hold. Lines already on the order stay
 * editable; archived products are deliberately not judged here.
 */
export function firstNewHiddenProduct<
  T extends {
    id: string;
    portalVisible?: boolean | null;
    parent?: { portalVisible?: boolean | null } | null;
  },
>(products: T[], heldProductIds: Set<string>): T | undefined {
  return products.find(
    (p) =>
      !heldProductIds.has(p.id) && (p.portalVisible === false || p.parent?.portalVisible === false),
  );
}

/** Throws the archived-style 400 for the first new hidden product (buyer replace-all). */
export function assertNoNewHiddenProduct(
  products: Array<{
    id: string;
    sku?: string | null;
    name?: string;
    portalVisible?: boolean | null;
    parent?: { portalVisible?: boolean | null } | null;
  }>,
  heldProductIds: Set<string>,
): void {
  const hidden = firstNewHiddenProduct(products, heldProductIds);
  if (hidden) throw new BadRequestException(`Product ${hidden.sku ?? hidden.name} is archived`);
}
