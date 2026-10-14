import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  keepLabelsAsOwnIncludes,
  LabelLockTimeoutError,
  syncCategoryLabel,
} from "../product-categories/label-writer";
import { computeEffectiveCategoryIds, type LabelChainLink } from "./effective-labels";
import { ancestorsOf, readableChainFrom } from "./parent-carries";

/**
 * H2 — "a reparent never drops a label". A variant carries the labels of its parent chain (the selling-restriction
 * engine's `computeEffectiveCategoryIds`); moving it to a parent that does not carry them would silently stop a legal
 * ban applying. So, in the SAME transaction as the `parentProductId` write, whatever was effective under the OLD parent
 * and is not under the NEW one (or none: an unlink) becomes the product's OWN INCLUDE, through the single label writer.
 *
 * SCOPE — LABELS ONLY. A selling restriction can also target a PRODUCT (`SellingRestriction.productId`), and the
 * engine applies such a rule to every product whose LINEAGE contains the target (`ruleMatchesProduct` in
 * selling-restrictions.core.ts: `lineageIds.has(rule.productId)`). So a rule targeting the OLD parent (or any old
 * ancestor) ALSO stops applying to the variant after a move or an unlink, and nothing here carries it: this function
 * only materialises labels. Row 509
 * extends this function for that case: for each surface-ALL product-target rule on the old lineage that the new one
 * lacks, it adds the variant as its OWN target, in the same transaction and under the same lock order (plan read-only,
 * locks first, re-check under the row locks).
 *
 * LOCK ORDER (SA #3457 MUST 3). `planReparentLabels` is read-only and runs BEFORE any row lock; update() takes the
 * planned labels' advisory locks (sorted, `lockLabelCategories`) right after its barcode locks, then the family/product
 * rows FOR UPDATE. `keepLabelsOnReparent` runs after the parent write and re-checks against `lockedCategoryIds`: a
 * label it would write outside that set is the retryable 409, never a label lock taken after a row lock (that order
 * cycles with `setLabel`, which takes the label lock and then the product row's FK KEY SHARE: 40P01).
 */

/**
 * A reparent whose OLD family chain can't be read in full (a cycle, deeper than the engine's cap, a missing or foreign
 * link). Reading it short would make the "before" set short and silently drop a ban, so the move is refused: a coded
 * 409 with fixed copy, thrown before any write.
 */
export class ProductChainUnreadableError extends ConflictException {
  constructor() {
    super({
      code: API_ERROR_CODES.PRODUCT_CHAIN_UNREADABLE,
      message: "This product's family chain can't be read.",
    });
    this.name = "ProductChainUnreadableError";
  }
}

/**
 * The effective category ids `productId` would carry under `parentId` (null = standalone): the engine's own pure rule
 * over [ancestors root-first, the product with its own rows], all read tenant-scoped. Independent of the product's
 * stored `parentProductId`, so it answers for the old and the new parent alike. NULL = the chain under `parentId`
 * can't be read in full (`readableChainFrom`): never a short set.
 */
export async function effectiveCategoryIdsUnder(
  tx: Prisma.TransactionClient,
  tenantId: string,
  productId: string,
  parentId: string | null,
): Promise<Set<string> | null> {
  let upward: string[] = [];
  if (parentId) {
    const parentOf = await ancestorsOf(tx, tenantId, [parentId]);
    const chain = readableChainFrom(parentOf, parentId, productId);
    if (!chain) return null;
    upward = chain;
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
 * READ-ONLY: the category ids `productId` carries under `fromParentId` and would NOT under `toParentId` (sorted; [] =
 * nothing lost, or no parent change). Throws `ProductChainUnreadableError` when the OLD chain can't be read in full.
 * An unreadable NEW chain loses everything that was effective before (fail closed: more is kept, never less).
 */
export async function planReparentLabels(
  tx: Prisma.TransactionClient,
  args: {
    tenantId: string;
    productId: string;
    fromParentId: string | null;
    toParentId: string | null;
  },
): Promise<string[]> {
  const { tenantId, productId, fromParentId, toParentId } = args;
  if ((fromParentId ?? null) === (toParentId ?? null)) return [];
  const before = await effectiveCategoryIdsUnder(tx, tenantId, productId, fromParentId);
  if (!before) throw new ProductChainUnreadableError();
  if (before.size === 0) return [];
  const after =
    (await effectiveCategoryIdsUnder(tx, tenantId, productId, toParentId)) ?? new Set<string>();
  return [...before].filter((id) => !after.has(id)).sort();
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
    /**
     * The label locks the caller took BEFORE its row locks (update(): the planned lost set + the text's label, sorted).
     * Re-checked here, under the row locks: a label outside it (the chain changed since the plan) is the retryable
     * 409 LabelLockTimeoutError, never a label lock taken after a row lock (the setLabel deadlock, 40P01).
     */
    lockedCategoryIds?: ReadonlySet<string>;
  },
): Promise<{ keptLabels: string[] }> {
  const { tenantId, productId, fromParentId, toParentId, lockedCategoryIds } = args;
  const lost = await planReparentLabels(tx, { tenantId, productId, fromParentId, toParentId });
  if (lockedCategoryIds && lost.some((id) => !lockedCategoryIds.has(id))) {
    throw new LabelLockTimeoutError();
  }
  if (lost.length === 0) return { keptLabels: [] };
  const kept = await keepLabelsAsOwnIncludes(tx, {
    tenantId,
    productId,
    categoryIds: lost,
    fromParentId,
    toParentId,
    actor: args.actor,
  });
  await syncCategoryLabel(tx, {
    tenantId,
    productId,
    text: args.text,
    actor: args.actor,
    lockedCategoryIds,
  });
  return { keptLabels: kept.map((k) => k.name) };
}
