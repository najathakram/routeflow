import { hiddenFromPortalRestriction } from "../selling-restrictions/selling-restrictions.service";
import { ForbiddenException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  isSellableProduct,
  SELLABLE_PARENT_FIELDS,
  sellableProductWhere,
} from "../products/sellable-product-where";

/**
 * What a buyer's request knows about selling restrictions. `restrictedIds` is the set of product ids the governing
 * selling-restrictions engine HIDES from this buyer in the portal (BLOCK and INDETERMINATE both hide, so a legal-ban
 * product is never shown and then refused at checkout; a portal-only limit fails open for a buyer with no state). It
 * applies whatever the staff-enforcement switch says. REQUIRED so no call site can forget it (SA-606 WS6); built by
 * `buyerVisibilityFor`. `noBuyerRestrictions(tenantId)` is the explicit "none", used only by `isBuyerVisibleBase` (the
 * order gate, where the engine itself is the authority).
 */
export interface BuyerVisibilityContext {
  restrictedIds: ReadonlySet<string>;
  /**
   * B1211, REQUIRED: the parent-visibility and sellable-parent relation filters also require the parent to belong to
   * this tenant, so a parent link that crosses tenants never makes a product visible. A context without a tenant
   * cannot be built (`noBuyerRestrictions` throws) and the builders refuse one: they never build an unscoped filter.
   */
  tenantId: string;
}

/** The explicit "no blocked ids" context for a tenant. A missing tenant id throws: it never yields an unscoped one. */
export function noBuyerRestrictions(
  tenantId: string | null | undefined,
  restrictedIds: ReadonlySet<string> = new Set(),
): BuyerVisibilityContext {
  if (!tenantId) throw new Error("buyer visibility requires a tenant id (B1211)");
  return { restrictedIds, tenantId };
}

/**
 * The visibility context of THIS buyer's request: the ids the selling-restrictions engine hides from them in the portal
 * (`restrictedProductIdsFor`: product and category rules, variants, label opt-outs, the buyer's state). EVERY buyer read
 * builds its context here (`selling-restrictions/portal-limits-pins.spec.ts` forbids a bare `noBuyerRestrictions(` anywhere else), and
 * a tenant with no active rule costs one indexed query.
 */
export async function buyerVisibilityFor(
  restrictions: {
    restrictedProductIdsFor(t: string, c: string | null, at?: Date): Promise<ReadonlySet<string>>;
  },
  tenantId: string | null | undefined,
  customerId: string | null | undefined,
  at: Date = new Date(),
): Promise<BuyerVisibilityContext> {
  if (!tenantId) throw new Error("buyer visibility requires a tenant id (B1211)");
  return {
    tenantId,
    restrictedIds: await restrictions.restrictedProductIdsFor(tenantId, customerId ?? null, at),
  };
}

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
  if (!ctx.tenantId) throw new Error("buyer visibility requires a tenant id (B1211)");
  return {
    AND: [
      sellableProductWhere(undefined, ctx.tenantId),
      { portalVisible: true },
      {
        OR: [
          { parentProductId: null },
          { parent: { portalVisible: true, tenantId: ctx.tenantId } },
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
    parent: { portalVisible: boolean; isActive: boolean; tenantId: string | null } | null;
  },
): boolean {
  return (
    isSellableProduct(p, ctx.tenantId) &&
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
export function isBuyerVisibleBase(
  p: Parameters<typeof isBuyerVisibleProduct>[1],
  tenantId: string,
): boolean {
  return isBuyerVisibleProduct(noBuyerRestrictions(tenantId), p);
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
  /** The loaded parent (null = standalone); its tenant is REQUIRED so the gate can refuse a cross-tenant link (B1211). */
  parent: { portalVisible: boolean; isActive: boolean; tenantId: string | null } | null;
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
  tenantId: string,
): void {
  const hidden = products.filter(
    (p) => p.isActive && !heldProductIds.has(p.id) && !isBuyerVisibleBase(p, tenantId),
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
export const PORTAL_PARENT_SELECT = {
  portalVisible: true,
  tenantId: true,
  ...SELLABLE_PARENT_FIELDS,
} as const;
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
  user: { role?: string | null; tenantId?: string | null } | null | undefined,
  products: readonly OrderableProduct[],
  opts: {
    held?: ReadonlySet<string> | ReadonlyArray<{ productId?: string | null }>;
    skip?: boolean;
  } = {},
): void {
  if (user?.role !== "CUSTOMER" || opts.skip) return;
  // B1211: a buyer without a tenant on the token is refused, never judged against an unscoped parent link.
  if (!user.tenantId) throw new ForbiddenException("Tenant context required");
  const held = opts.held ?? [];
  assertBuyerMayOrder(
    products,
    "has" in held
      ? held
      : new Set((held as ReadonlyArray<{ productId?: string | null }>).map((l) => l.productId!)),
    user.tenantId,
  );
}
