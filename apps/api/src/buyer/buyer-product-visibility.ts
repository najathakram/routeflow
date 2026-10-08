import { hiddenFromPortalRestriction } from "../selling-restrictions/selling-restrictions.service";
import type { Prisma } from "@prisma/client";
import {
  isSellableProduct,
  SELLABLE_PARENT_FIELDS,
  sellableProductWhere,
} from "../products/sellable-product-where";

/**
 * What a buyer's request knows about selling restrictions. `restrictedIds` is the set of product ids the governing
 * selling-restrictions engine BLOCKS for this buyer (INDETERMINATE stays visible: checkout is the authority), already
 * empty when the tenant's restriction switch is off. It is REQUIRED so no call site can forget it (SA-606 WS6);
 * `NO_BUYER_RESTRICTIONS` is the explicit "none" until `restrictedProductIdsFor` is wired at a site.
 */
export interface BuyerVisibilityContext {
  restrictedIds: ReadonlySet<string>;
  /**
   * B1211: when given, the parent-visibility relation filter also requires the parent to belong to this tenant, so a
   * parent link that crosses tenants never makes a product visible (or hidden). Omitted = the filter is unchanged.
   */
  tenantId?: string;
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
      {
        OR: [
          { parentProductId: null },
          { parent: { portalVisible: true, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) } },
        ],
      },
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
    parent: { portalVisible: boolean; isActive: boolean } | null;
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
 * (inactive, FAMILY, hidden, hidden or inactive parent). Same required fields as the twin.
 */
export function isBuyerVisibleBase(p: Parameters<typeof isBuyerVisibleProduct>[1]): boolean {
  return isBuyerVisibleProduct(NO_BUYER_RESTRICTIONS, p);
}

/**
 * The product facts the refusal reads. `kind`, `portalVisible` and `parent` are REQUIRED (SA-612): a caller whose select
 * forgets them is a compile error, never a silently orderable product (the old defaults failed open).
 */
interface OrderableProduct {
  id: string;
  name: string;
  isActive: boolean;
  kind: string;
  portalVisible: boolean;
  /** The loaded parent (null = standalone). */
  parent: { portalVisible: boolean; isActive: boolean } | null;
}

/**
 * The ONE buyer order-write gate (SA-606 WS6 "Refusal"): a BUYER order naming a NEW product the catalog would hide
 * (portal-hidden, under a hidden parent, or a FAMILY container) is a 409 in the EXISTING buyer envelope (the
 * SELLING_RESTRICTED code with `blockedLines: [{ productId, productName, reason: "HIDDEN_FROM_PORTAL" }]`), so the
 * cart's blocked-lines dialog opens. EVERY new hidden product is named, not the first. `heldProductIds` are lines the
 * order already holds (replace-all keeps them editable). An archived product (`isActive === false`) is not judged
 * here: the archived 400 rules stay as they were. The reason appears on buyer lines ONLY for this case; a state or ban
 * reason stays staff-only (selling-restrictions.service.ts).
 */
export function assertBuyerMayOrder(
  products: readonly OrderableProduct[],
  heldProductIds: ReadonlySet<string>,
): void {
  const hidden = products.filter(
    (p) => p.isActive && !heldProductIds.has(p.id) && !isBuyerVisibleBase(p),
  );
  if (hidden.length === 0) return;
  throw hiddenFromPortalRestriction(
    hidden.map((p) => ({
      productId: p.id,
      productName: p.name,
      reason: "HIDDEN_FROM_PORTAL" as const,
    })),
  );
}

/**
 * The parent's `portalVisible` and `isActive`, which the visibility gate needs on every product it judges (a hidden or
 * inactive parent hides its variants).
 */
export const PORTAL_PARENT_SELECT = { portalVisible: true, ...SELLABLE_PARENT_FIELDS } as const;
export const PORTAL_PARENT_INCLUDE = { parent: { select: PORTAL_PARENT_SELECT } } as const;

/** `findMany` args for the products an order names: by id, WITH the parent's `portalVisible` the gate needs. */
export const portalGateArgs = (ids: string[]) =>
  ({ where: { id: { in: ids } }, include: PORTAL_PARENT_INCLUDE }) as const;

/**
 * The order paths' call: for a BUYER (CUSTOMER) apply `assertBuyerMayOrder` before anything else runs (so the buyer 409
 * comes before the staff-facing FAMILY 400); staff are untouched. `held` = lines the order already holds; `skip` = the
 * caller's own exemption (an archived product is allowed on that path, so it is not judged).
 */
export function assertBuyerLines(
  role: string | null | undefined,
  products: readonly OrderableProduct[],
  opts: {
    held?: ReadonlySet<string> | ReadonlyArray<{ productId?: string | null }>;
    skip?: boolean;
  } = {},
): void {
  if (role !== "CUSTOMER" || opts.skip) return;
  const held = opts.held ?? [];
  assertBuyerMayOrder(
    products,
    "has" in held
      ? held
      : new Set((held as ReadonlyArray<{ productId?: string | null }>).map((l) => l.productId!)),
  );
}
