import { Prisma } from "@prisma/client";
import { keepLabelsAsOwnIncludes, syncCategoryLabel } from "../product-categories/label-writer";
import { computeEffectiveCategoryIds, type LabelChainLink } from "./effective-labels";
import { ancestorChain, ancestorsOf } from "./parent-carries";

/**
 * H2 — "a reparent never drops a label". A variant carries the labels of its parent chain (the selling-restriction
 * engine's `computeEffectiveCategoryIds`); moving it to a parent that does not carry them would silently stop a legal
 * ban applying. So, in the SAME transaction as the `parentProductId` write, whatever was effective under the OLD parent
 * and is not under the NEW one (or none: an unlink) becomes the product's OWN INCLUDE, through the single label writer.
 */

/**
 * The effective category ids `productId` would carry under `parentId` (null = standalone): the engine's own pure rule
 * over [ancestors root-first, the product with its own rows], all read tenant-scoped. Independent of the product's
 * stored `parentProductId`, so it answers for the old and the new parent alike.
 */
export async function effectiveCategoryIdsUnder(
  tx: Prisma.TransactionClient,
  tenantId: string,
  productId: string,
  parentId: string | null,
): Promise<Set<string>> {
  let upward: string[] = [];
  if (parentId) {
    const parentOf = await ancestorsOf(tx, tenantId, [parentId]);
    upward = [parentId, ...ancestorChain(parentOf, parentId)];
  }
  const ids = [productId, ...upward];
  const rows = await tx.productCategoryLabel.findMany({
    where: { tenantId, productId: { in: ids } },
    select: { productId: true, categoryId: true, mode: true, parentProductIdAtWrite: true },
  });
  const link = (id: string): LabelChainLink => ({
    productId: id,
    assignments: rows
      .filter((r) => r.productId === id)
      .map((r) => ({
        categoryId: r.categoryId,
        mode: r.mode,
        parentProductIdAtWrite: r.parentProductIdAtWrite,
      })),
  });
  return computeEffectiveCategoryIds([...upward].reverse().concat(productId).map(link));
}

/**
 * Call after the `parentProductId` write (same tx). Materialises `before \ after` as own INCLUDEs, then runs the
 * add-only category-text sync. Writes NOTHING when nothing is lost. `keptLabels` = the kept labels' names (the response note).
 */
export async function keepLabelsOnReparent(
  tx: Prisma.TransactionClient,
  args: {
    tenantId: string;
    productId: string;
    fromParentId: string | null;
    toParentId: string | null;
    /** The product's category text after the write, for the add-only sync. */
    text?: string | null;
    actor?: { id: string | null; name: string | null };
  },
): Promise<{ keptLabels: string[] }> {
  const { tenantId, productId, fromParentId, toParentId } = args;
  if ((fromParentId ?? null) === (toParentId ?? null)) return { keptLabels: [] };
  const before = await effectiveCategoryIdsUnder(tx, tenantId, productId, fromParentId);
  if (before.size === 0) return { keptLabels: [] };
  const after = await effectiveCategoryIdsUnder(tx, tenantId, productId, toParentId);
  const lost = [...before].filter((id) => !after.has(id));
  if (lost.length === 0) return { keptLabels: [] };
  const kept = await keepLabelsAsOwnIncludes(tx, {
    tenantId,
    productId,
    categoryIds: lost,
    fromParentId,
    toParentId,
    actor: args.actor,
  });
  await syncCategoryLabel(tx, { tenantId, productId, text: args.text, actor: args.actor });
  return { keptLabels: kept.map((k) => k.name) };
}
