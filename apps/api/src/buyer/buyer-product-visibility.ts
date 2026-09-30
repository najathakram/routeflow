import { BadRequestException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { isSellableProduct, sellableProductWhere } from "../products/sellable-product-where";

/**
 * What a buyer's request knows about selling restrictions. `restrictedIds` is the set of product ids the governing
 * selling-restrictions engine BLOCKS for this buyer (INDETERMINATE stays visible: checkout is the authority), already
 * empty when the tenant's restriction switch is off. It is REQUIRED so no call site can forget it (SA-606 WS6);
 * `NO_BUYER_RESTRICTIONS` is the explicit "none" until `restrictedProductIdsFor` is wired at a site.
 */
export interface BuyerVisibilityContext {
  restrictedIds: ReadonlySet<string>;
}
export const NO_BUYER_RESTRICTIONS: BuyerVisibilityContext = { restrictedIds: new Set() };

/**
 * The ONE predicate for "a product a BUYER may see" (L-167: one shared builder, never a
 * call-site copy): sellable (active and not a FAMILY container, via `sellableProductWhere`) AND `portalVisible` AND
 * (standalone OR its parent is `portalVisible`) AND not in the buyer's blocked set. For a buyer a portal-hidden product
 * behaves exactly like an inactive one on every product read. A hidden PARENT hides ALL its variants (via
 * parentProductId, independent of `kind`). Past orders/invoices are not product reads and keep showing hidden
 * products; staff paths never use this.
 *
 * `extra` is AND-composed as its own clause, so it can narrow but never override or widen the
 * visibility clauses above it.
 */
export function buyerVisibleProductWhere(
  ctx: BuyerVisibilityContext,
  extra?: Prisma.ProductWhereInput,
): Prisma.ProductWhereInput {
  return {
    AND: [
      sellableProductWhere(),
      { portalVisible: true },
      { OR: [{ parentProductId: null }, { parent: { portalVisible: true } }] },
      ...(ctx.restrictedIds.size > 0 ? [{ id: { notIn: [...ctx.restrictedIds] } }] : []),
      ...(extra ? [extra] : []),
    ],
  };
}

/** Thin id-lookup form of the builder. */
export function buyerVisibleProductByIdWhere(
  ctx: BuyerVisibilityContext,
  id: string,
): Prisma.ProductWhereInput {
  return buyerVisibleProductWhere(ctx, { id });
}

/**
 * In-memory twin of `buyerVisibleProductWhere` for rows already loaded (detail, favorites,
 * replenishment). EVERY field is REQUIRED in the type: a select that forgets `portalVisible`, `kind`,
 * `isActive` or the loaded `parent` (null = standalone) is a compile error, never a silently visible product
 * (the old "missing flag counts as visible" failed open).
 */
export function isBuyerVisibleProduct(
  ctx: BuyerVisibilityContext,
  p: {
    id: string;
    isActive: boolean;
    kind: string;
    portalVisible: boolean;
    parent: { portalVisible: boolean } | null;
  },
): boolean {
  return (
    isSellableProduct(p) &&
    p.portalVisible &&
    (p.parent === null || p.parent.portalVisible) &&
    !ctx.restrictedIds.has(p.id)
  );
}

/**
 * The twin WITHOUT the blocked-id clause, for the order-write gates (create / edit-add): there the selling-restrictions
 * engine (`checkLinesSellable`) is the authority, so the gate only refuses what the catalog would never show
 * (inactive, FAMILY, hidden, hidden parent). Same required fields as the twin.
 */
export function isBuyerVisibleBase(p: Parameters<typeof isBuyerVisibleProduct>[1]): boolean {
  return isBuyerVisibleProduct(NO_BUYER_RESTRICTIONS, p);
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
