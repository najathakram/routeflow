import type { Prisma } from "@prisma/client";
import { tenantSafeParent } from "./product-parent";

/** The parent facts the sellable rule reads; the buyer builder spreads it into its own parent select. */
export const SELLABLE_PARENT_FIELDS = { isActive: true } as const;

/**
 * WS6 / WS8 (SA-606): the ONE "a product that can be sold" predicate — active, NOT a FAMILY container (a FAMILY is
 * non-stocked and non-sellable) and, for a variant, under an ACTIVE parent family (B1213: a variant is only as live
 * as its family; an archived family hides its variants even if their own flag is still set). The buyer builder
 * (`buyer/buyer-product-visibility.ts`) composes it and never keeps a copy (L-167); staff write paths refuse a FAMILY
 * line through `assertSellableLines` (`products/sellable-lines.ts`), which states the same rule for an
 * order/invoice/estimate/PO line. `extra` is AND-composed as its own clause, so it can narrow but never widen.
 * `tenantId` (B1211) is REQUIRED: the parent relation filter also requires the parent to belong to that tenant, so a
 * parent link that crosses tenants never makes a variant sellable. A missing tenant throws, it never builds an
 * unscoped predicate.
 */
export function sellableProductWhere(
  extra: Prisma.ProductWhereInput | undefined,
  tenantId: string,
): Prisma.ProductWhereInput {
  if (!tenantId) throw new Error("sellableProductWhere requires a tenant id (B1211)");
  return {
    AND: [
      { isActive: true },
      { kind: { not: "FAMILY" } },
      {
        OR: [{ parentProductId: null }, { parent: { ...SELLABLE_PARENT_FIELDS, tenantId } }],
      },
      ...(extra ? [extra] : []),
    ],
  };
}

/**
 * In-memory twin for rows already loaded. `kind` and `parent` are REQUIRED (`parent` = the loaded parent, null =
 * standalone), so a select that forgets either is a compile error, never a silently sellable product. `tenantId` is
 * REQUIRED too (B1211): a variant is judged only against a parent of that tenant, and with no tenant known it is not
 * sellable.
 */
export function isSellableProduct(
  p: {
    isActive: boolean;
    kind: string;
    parent: { isActive: boolean; tenantId?: string | null } | null;
  },
  tenantId: string,
): boolean {
  if (!p.isActive || p.kind === "FAMILY") return false;
  if (p.parent === null) return true;
  // Fail closed: a row that never loaded its parent (undefined) is not sellable, never silently standalone.
  if (!p.parent || !tenantId) return false;
  // A parent of another tenant (or one that does not carry its tenant) is never followed (B1211), as in the where.
  return tenantSafeParent(p.parent, tenantId)?.isActive === true;
}
