import { Prisma } from "@prisma/client";
import {
  computeEffectiveCategoryIds,
  type LabelAssignment,
  type LabelChainLink,
} from "./effective-labels";

/**
 * "Variants FOLLOW the parent" (SA, labels-from-categories): an automatic label add never gives a product its own
 * membership when its PARENT CHAIN already carries the label — the variant inherits it, so removing the parent's label
 * later un-restricts the variant too. The rule is the engine's own (`computeEffectiveCategoryIds`), evaluated on the
 * chain ending at the product's PARENT. READ side only: it never writes.
 *
 * Shared by the single label writer (product-categories/label-writer.ts) and the backfill script (through dist), so
 * the script's plan and its write can never disagree.
 */

/** The engine's ancestor cap (product-labels.service.ts): a deeper / cyclic / broken chain is unresolvable. */
const MAX_HOPS = 5;

/** Parent links and label rows the check needs. `rows`: productId -> its assignments (any category). */
export interface InheritanceState {
  parentOf: ReadonlyMap<string, string | null>;
  rows: ReadonlyMap<string, LabelAssignment[]>;
}

/**
 * Does the chain ending at `productId`'s PARENT carry `categoryId`? `planned` = products about to gain an INCLUDE of it
 * in the same run (they count as carrying). A product with no parent, or an unresolvable chain (missing link, cycle,
 * deeper than the cap), is NOT inheriting: it gets its own membership (the label applies either way).
 */
export function parentChainCarries(
  state: InheritanceState,
  productId: string,
  categoryId: string,
  planned?: ReadonlySet<string>,
): boolean {
  const parent = state.parentOf.get(productId) ?? null;
  if (!parent) return false;
  const upward: string[] = [];
  const seen = new Set<string>([productId]);
  let cursor: string | null = parent;
  while (cursor) {
    if (upward.length >= MAX_HOPS || seen.has(cursor) || !state.parentOf.has(cursor)) return false;
    seen.add(cursor);
    upward.push(cursor);
    cursor = state.parentOf.get(cursor) ?? null;
  }
  const chain: LabelChainLink[] = upward.reverse().map((id) => ({
    productId: id,
    assignments: [
      ...(state.rows.get(id) ?? []).filter((a) => a.categoryId === categoryId),
      ...(planned?.has(id) ? [{ categoryId, mode: "INCLUDE" as const }] : []),
    ],
  }));
  return computeEffectiveCategoryIds(chain).has(categoryId);
}

const rowsByProduct = (
  list: Array<{
    productId: string;
    categoryId: string;
    mode: "INCLUDE" | "EXCLUDE";
    parentProductIdAtWrite: string | null;
  }>,
) => {
  const m = new Map<string, LabelAssignment[]>();
  for (const r of list) {
    const a: LabelAssignment = {
      categoryId: r.categoryId,
      mode: r.mode,
      parentProductIdAtWrite: r.parentProductIdAtWrite,
    };
    m.set(r.productId, [...(m.get(r.productId) ?? []), a]);
  }
  return m;
};

/** The WHOLE tenant's parent links and label rows (the backfill's one read: two queries for any catalog size). */
export async function loadInheritanceState(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<InheritanceState> {
  const products = await tx.product.findMany({
    where: { tenantId },
    select: { id: true, parentProductId: true },
  });
  const rows = await tx.productCategoryLabel.findMany({
    where: { tenantId },
    select: { productId: true, categoryId: true, mode: true, parentProductIdAtWrite: true },
  });
  return {
    parentOf: new Map(products.map((p) => [p.id, p.parentProductId])),
    rows: rowsByProduct(rows),
  };
}

/**
 * The ancestors of `productIds` (and the products themselves) as parent links, one query per level up to the cap.
 * A link absent from the map is unknown (another tenant's / missing): callers treat that chain as unresolvable.
 */
export async function ancestorsOf(
  tx: Prisma.TransactionClient,
  tenantId: string,
  productIds: readonly string[],
): Promise<Map<string, string | null>> {
  const parentOf = new Map<string, string | null>();
  let frontier = [...new Set(productIds)];
  for (let level = 0; level <= MAX_HOPS + 1 && frontier.length > 0; level++) {
    const found = await tx.product.findMany({
      where: { tenantId, id: { in: frontier } },
      select: { id: true, parentProductId: true },
    });
    for (const p of found) parentOf.set(p.id, p.parentProductId);
    frontier = [
      ...new Set(
        found.map((p) => p.parentProductId).filter((id): id is string => !!id && !parentOf.has(id)),
      ),
    ];
  }
  return parentOf;
}

/** The ancestors of `productId` nearest first (parent, grandparent, …), up to the cap; stops at a cycle / unknown link. */
export function ancestorChain(
  parentOf: ReadonlyMap<string, string | null>,
  productId: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>([productId]);
  let cursor = parentOf.get(productId) ?? null;
  while (cursor && out.length < MAX_HOPS && !seen.has(cursor)) {
    out.push(cursor);
    seen.add(cursor);
    if (!parentOf.has(cursor)) break;
    cursor = parentOf.get(cursor) ?? null;
  }
  return out;
}

/**
 * Of `productIds`, the ones whose parent chain carries `categoryId` (counting `planned` as carrying). Loads only the
 * ancestors it needs, one query per level (≤ the cap), plus one for that label's rows on them.
 */
export async function productsInheritingLabel(
  tx: Prisma.TransactionClient,
  tenantId: string,
  categoryId: string,
  productIds: readonly string[],
  planned?: ReadonlySet<string>,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (productIds.length === 0) return out;
  const parentOf = await ancestorsOf(tx, tenantId, productIds);
  const rows = await tx.productCategoryLabel.findMany({
    where: { tenantId, categoryId, productId: { in: [...parentOf.keys()] } },
    select: { productId: true, categoryId: true, mode: true, parentProductIdAtWrite: true },
  });
  const state: InheritanceState = { parentOf, rows: rowsByProduct(rows) };
  for (const id of productIds) if (parentChainCarries(state, id, categoryId, planned)) out.add(id);
  return out;
}
