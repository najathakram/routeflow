import type { Prisma } from "@prisma/client";
import { displayCategory } from "./product-display-name";

/**
 * B2 (SA ruling 2026-10-14, row 527): regulated attributes are resolved at READ time, through this ONE module.
 *
 * A variant created from the family grid carries none of its family's regulated facts (regulated type, tobacco flag,
 * regulatory codes), so every compliance read of a variant row alone said "not regulated" and the sale escaped the
 * licence check, the age/ID delivery gate, the excise levy, the tobacco/MSA report and the filing. Nothing is copied
 * onto the variant (no write-time copy, no backfill): every compliance read asks this resolver instead.
 *
 * `effectiveProductAttributes(product, parentChain)` (nearest ancestor first; the depth is 1 today, the chain makes
 * it 1..n):
 *  - REGULATED (`isTobacco`, `trackedCategoryIds`, `isRegulated`): a fail-closed UNION. A product is regulated when it
 *    OR ANY ancestor is, and a variant can never opt out (its own `false` / null never cancels the family's `true`).
 *    "Regulated" means: `isTobacco` is true (the legacy shadow mirror of the Tobacco type) or a `trackedCategoryId`
 *    (the going-forward regulated type) is set. `trackedCategoryIds` is the union of every type in the chain, own
 *    first; a licence gate must hold every one of them.
 *  - `trackedCategoryId`: the single type a line is stamped with: the product's own, else the nearest ancestor's.
 *  - REGULATORY CODES (`regItemType`, `regUomCase`, `regUomUnit`, `trackedSubcategoryId`): the product's own when set,
 *    else the nearest ancestor's. One guard: an ancestor in a DIFFERENT regulated type than the effective one does
 *    not lend its codes (they belong to another report template and would not validate). A subcategory is only
 *    taken from a product whose type is the effective type.
 *  - `category` (the free-text label): `displayCategory` (own, else the parent's), reused, never forked.
 *
 * Every consumer reaches this through one of the helpers below, so a site is either routed (and census-pinned by
 * `effective-product-attributes.census.spec.ts`) or it is an explicit, reasoned exemption there.
 */

/** The facts of one product row the resolver reads. Every field optional: a narrow select simply has none. */
export interface RegulatedSource {
  isTobacco?: boolean | null;
  trackedCategoryId?: string | null;
  trackedSubcategoryId?: string | null;
  regItemType?: string | null;
  regUomCase?: string | null;
  regUomUnit?: string | null;
  category?: string | null;
}

export interface EffectiveProductAttributes {
  /** True when the product or any ancestor is regulated. Never false for a variant of a regulated family. */
  isRegulated: boolean;
  /** Tobacco flag: the product's OR any ancestor's. */
  isTobacco: boolean;
  /** The type a line is stamped with: own, else the nearest ancestor's. Null = no regulated type anywhere. */
  trackedCategoryId: string | null;
  /** Every regulated type in the chain (own first, de-duplicated): what a licence gate must check. */
  trackedCategoryIds: readonly string[];
  trackedSubcategoryId: string | null;
  regItemType: string | null;
  regUomCase: string | null;
  regUomUnit: string | null;
  /** Category text: `displayCategory` (own, else the parent's). */
  category: string | null;
}

const set = (v: string | null | undefined): v is string => v != null && v !== "";

export function effectiveProductAttributes(
  product: RegulatedSource,
  parentChain: ReadonlyArray<RegulatedSource> = [],
): EffectiveProductAttributes {
  const chain: RegulatedSource[] = [product, ...parentChain];
  const isTobacco = chain.some((p) => p.isTobacco === true);
  const trackedCategoryIds = [
    ...new Set(chain.map((p) => p.trackedCategoryId).filter((id): id is string => set(id))),
  ];
  const trackedCategoryId = trackedCategoryIds[0] ?? null;
  // A product may lend its codes only when it is the product itself or sits in the EFFECTIVE type.
  const lends = (p: RegulatedSource, i: number): boolean =>
    i === 0 || (p.trackedCategoryId ?? null) === trackedCategoryId;
  const firstSet = (pick: (p: RegulatedSource) => string | null | undefined): string | null => {
    for (let i = 0; i < chain.length; i++) {
      const v = pick(chain[i]);
      if (lends(chain[i], i) && set(v)) return v;
    }
    return null;
  };
  // Category text: fold displayCategory up the chain (own, else the nearest ancestor that has one).
  let category: string | null = displayCategory(product, parentChain[0]);
  for (let i = 1; i < parentChain.length && category == null; i++) {
    category = displayCategory({ category: null }, parentChain[i]);
  }
  return {
    isRegulated: isTobacco || trackedCategoryIds.length > 0,
    isTobacco,
    trackedCategoryId,
    trackedCategoryIds,
    trackedSubcategoryId: firstSet((p) =>
      (p.trackedCategoryId ?? null) === trackedCategoryId ? p.trackedSubcategoryId : null,
    ),
    regItemType: firstSet((p) => p.regItemType),
    regUomCase: firstSet((p) => p.regUomCase),
    regUomUnit: firstSet((p) => p.regUomUnit),
    category,
  };
}

// ── Loading the chain ───────────────────────────────────────────────────────────────────────────────────

/** The columns a parent contributes. `tenantId` rides along only for the cross-tenant check (B1211). */
export const REGULATED_PARENT_SELECT = {
  id: true,
  tenantId: true,
  isTobacco: true,
  trackedCategoryId: true,
  trackedSubcategoryId: true,
  regItemType: true,
  regUomCase: true,
  regUomUnit: true,
  category: true,
} as const;

/** Spread into a product `select`, or use as an `include`: the parent facts + the link the resolver needs. */
export const REGULATED_PARENT_INCLUDE = { parent: { select: REGULATED_PARENT_SELECT } } as const;
export const REGULATED_PARENT_SELECT_FIELDS = {
  parentProductId: true,
  ...REGULATED_PARENT_INCLUDE,
} as const;

/** A product row as the loaders return it: its own facts plus the link and the (optional) loaded parent. */
export type RowWithParent = RegulatedSource & {
  parentProductId: string | null;
  parent: (RegulatedSource & { tenantId?: string | null }) | null;
};

/**
 * The parent chain of a loaded row. `parentProductId` and `parent` are REQUIRED by the type, so a select that forgets
 * either is a compile error and never a silently standalone product. A parent KNOWN to belong to another tenant is not
 * followed (B1211: its type ids are foreign); an unknown tenant is followed, because for REGULATION the closed
 * direction is "regulated" (the opposite of the sellable rule, which closes to "not sellable").
 */
export function parentChainOf(
  row: Pick<RowWithParent, "parent">,
  tenantId: string | null | undefined,
): RegulatedSource[] {
  const parent = row.parent;
  if (!parent) return [];
  if (tenantId && parent.tenantId != null && parent.tenantId !== tenantId) return [];
  return [parent];
}

/** The effective attributes of a loaded row (its parent included by `REGULATED_PARENT_INCLUDE`). */
export function effectiveOf(
  row: RowWithParent,
  tenantId: string | null | undefined,
): EffectiveProductAttributes {
  return effectiveProductAttributes(row, parentChainOf(row, tenantId));
}

/**
 * The row with its regulated COLUMNS replaced by the effective ones, so code written against `product.trackedCategoryId`
 * / `product.isTobacco` keeps working and now sees the resolved value. A key the row's select omitted is not added.
 * Use it only on a READ path: never write the result back (that would be the write-time copy this ruling forbids).
 */
export function withEffectiveAttributes<T extends RowWithParent>(
  row: T,
  tenantId: string | null | undefined,
): T {
  const eff = effectiveOf(row, tenantId);
  const out: Record<string, unknown> = { ...row };
  const put = (key: keyof RegulatedSource & keyof EffectiveProductAttributes) => {
    if (key in row) out[key] = eff[key];
  };
  put("isTobacco");
  put("trackedCategoryId");
  put("trackedSubcategoryId");
  put("regItemType");
  put("regUomCase");
  put("regUomUnit");
  return out as T;
}

/** `withEffectiveAttributes` over a list: the one-liner a loader site appends to its `findMany`. */
export function withEffectiveAll<T extends RowWithParent>(
  rows: readonly T[],
  tenantId: string | null | undefined,
): T[] {
  return rows.map((r) => withEffectiveAttributes(r, tenantId));
}

interface ProductReadDb {
  product: { findMany(args: any): Promise<any[]> };
}

/** Effective attributes by product id, in ONE query (the product + its parent). Unknown ids are absent. */
export async function loadEffectiveAttributes(
  db: ProductReadDb,
  tenantId: string | null | undefined,
  productIds: Iterable<string | null | undefined>,
): Promise<Map<string, EffectiveProductAttributes>> {
  const ids = [...new Set([...productIds].filter((id): id is string => !!id))];
  const out = new Map<string, EffectiveProductAttributes>();
  if (ids.length === 0) return out;
  const rows: Array<RowWithParent & { id: string }> = await db.product.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      isTobacco: true,
      trackedCategoryId: true,
      trackedSubcategoryId: true,
      regItemType: true,
      regUomCase: true,
      regUomUnit: true,
      category: true,
      ...REGULATED_PARENT_SELECT_FIELDS,
    },
  });
  for (const r of rows) out.set(r.id, effectiveOf(r, tenantId));
  return out;
}

// ── The SQL-side twin: where fragments (a report/list query cannot call the function above) ──────────────

type TenantArg = string | null | undefined;

/** The parent relation filter. With a tenant it also requires the parent to be that tenant's (B1211). */
const parentIs = (
  tenantId: TenantArg,
  where: Prisma.ProductWhereInput,
): Prisma.ProductWhereInput => ({
  parent: { is: { ...(tenantId ? { tenantId } : {}), ...where } },
});

/**
 * `where` for "tobacco, effectively": the product's flag OR its parent's. Pass the request's `tenantId` so a parent
 * of ANOTHER tenant is never followed (same as the resolver's `parentChainOf`); with none the parent is unscoped,
 * which only ever widens "regulated" (fail closed).
 */
export function tobaccoProductWhere(tenantId?: TenantArg): Prisma.ProductWhereInput {
  const own: Prisma.ProductWhereInput = { isTobacco: true };
  return { OR: [own, parentIs(tenantId, own)] };
}

/** The complement: neither the product nor its parent is tobacco (`isTobacco` is NOT NULL, so no null trap). */
export function notTobaccoProductWhere(tenantId?: TenantArg): Prisma.ProductWhereInput {
  return {
    isTobacco: false,
    OR: [{ parentProductId: null }, parentIs(tenantId, { isTobacco: false })],
  };
}

/** `where` for "effectively regulated": a tobacco flag or a regulated type on the product or its parent. */
export function regulatedProductWhere(tenantId?: TenantArg): Prisma.ProductWhereInput {
  const own: Prisma.ProductWhereInput = {
    OR: [{ isTobacco: true }, { trackedCategoryId: { not: null } }],
  };
  return { OR: [own, parentIs(tenantId, own)] };
}

/** `where` for "the product or its parent is in one of these regulated types" (the union, fail closed). */
export function inRegulatedCategoriesWhere(
  categoryIds: readonly string[],
  tenantId?: TenantArg,
): Prisma.ProductWhereInput {
  const own: Prisma.ProductWhereInput = { trackedCategoryId: { in: [...categoryIds] } };
  return { OR: [own, parentIs(tenantId, own)] };
}

/**
 * The complement of `inRegulatedCategoriesWhere`, with the null trap handled in the open: a product with NO type
 * must stay visible (`trackedCategoryId: { notIn }` alone drops the NULL rows), and so must a standalone product.
 * A variant is visible only when neither it nor its parent sits in the listed types.
 */
export function outsideRegulatedCategoriesWhere(
  categoryIds: readonly string[],
  tenantId?: TenantArg,
): Prisma.ProductWhereInput {
  const clear: Prisma.ProductWhereInput = {
    OR: [{ trackedCategoryId: null }, { trackedCategoryId: { notIn: [...categoryIds] } }],
  };
  return { AND: [clear, { OR: [{ parentProductId: null }, parentIs(tenantId, clear)] }] };
}

/** In-memory twin of `inRegulatedCategoriesWhere` for a row already resolved. */
export function inAnyCategory(
  eff: Pick<EffectiveProductAttributes, "trackedCategoryIds">,
  categoryIds: ReadonlySet<string>,
): boolean {
  return eff.trackedCategoryIds.some((id) => categoryIds.has(id));
}
