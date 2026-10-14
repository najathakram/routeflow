import { BadRequestException, ConflictException } from "@nestjs/common";
import { OrderStatus, Prisma } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { lockProductsForStock } from "../common/product-locks";
import { lockCodesOfProducts, peekProductCodes, releaseProductCodes } from "./product-code-release";
import { type CatalogTx } from "./product-catalog-sync";
import { recipeReferenceGroupers } from "./recipe-references";

/**
 * Product delete, one rule set for the single and the bulk path.
 *
 * HISTORY IS NEVER DELETED. A product that any order, invoice, stock, bill, template or recipe row names is
 * deactivated (the same archive `remove()` does), never removed, and none of those rows is ever written by a delete.
 * Only a product nothing names is removed, and that is decided INSIDE the delete transaction, after the product rows
 * are locked (`applyProductDelete`): a foreign-key insert needs a KEY SHARE lock on the product row, so a sale
 * that commits first is seen by the re-classification, and one that arrives later waits for the delete to finish.
 *
 * "Active" is read off the ORDER (`order.status`), never off `OrderItem.status`: a sold line stays PENDING for its
 * whole life, so the line status cannot tell an open order from a delivered one.
 */

/** An order in one of these states is finished; every other state (DRAFT .. PARTIALLY_DELIVERED) is still open. */
export const TERMINAL_ORDER_STATUSES: OrderStatus[] = ["DELIVERED", "CANCELLED"];

/** `OrderItem` where-clause: lines of `productId`(s) that sit on a still-open order. */
export function activeOrderItemWhere(productIds: string | readonly string[]) {
  return {
    productId: typeof productIds === "string" ? productIds : { in: [...productIds] },
    order: { status: { notIn: TERMINAL_ORDER_STATUSES } },
  };
}

/** One product a bulk delete refused: a machine `code` (clients show fixed copy for it) and the legacy `reason` sentence. */
export interface BulkDeleteSkip {
  id: string;
  code: string;
  reason: string;
}

export interface ProductDeletePlan {
  /** Left untouched, each with a coded reason. */
  skipped: BulkDeleteSkip[];
  /** Referenced by a record: deactivated, no row touched. */
  softIds: string[];
  /** Named by nothing: removed. */
  hardIds: string[];
}

/** 400 from DELETE /products/:id: a still-open order has a line for this product. */
export function productHasActiveOrderItems(): BadRequestException {
  return new BadRequestException({
    code: API_ERROR_CODES.PRODUCT_HAS_ACTIVE_ORDER_ITEMS,
    message: "Cannot delete product with active order items",
  });
}

/** 409: the product changed while it was being deleted; nothing was deleted. */
export function productDeleteConflict(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.PRODUCT_DELETE_CONFLICT,
    message:
      "A product in this selection changed while it was being deleted, so the delete did not go through. Reload the list and try again.",
  });
}

/**
 * A unique violation (P2002, e.g. a variant orphaned by the delete colliding with a same-named product) or a
 * foreign-key violation (P2003, a RESTRICT reference that appeared after the lock) is a coded 409 (the delete is
 * one transaction, nothing was written), never an uncoded 500. Anything else is returned untouched.
 */
export function mapProductDeleteError(e: unknown): unknown {
  const code = (e as { code?: unknown } | null)?.code;
  if (e instanceof Prisma.PrismaClientKnownRequestError && (code === "P2002" || code === "P2003")) {
    return productDeleteConflict();
  }
  return e;
}

type DeleteDb = CatalogTx;

/**
 * Classify `ids` against the records that name them. `db` is the tenant client for the cheap pre-lock read (which
 * only chooses WHICH codes to lock) and the transaction client for the authoritative read under the locks.
 *
 *   1. a line on a still-open order        -> skipped, PRODUCT_HAS_ACTIVE_ORDER_ITEMS
 *   2. any other reference                  -> soft (deactivate)
 *   3. a family with a live variant         -> skipped (FAMILY_HAS_ACTIVE_VARIANTS) or forced soft (B1212)
 *   4. nothing names it                     -> hard
 *
 * ONE grouped query per dependent table (never per id, never a row fetch): the DTO allows 500 ids and clearAll()
 * passes the whole catalog.
 */
export async function planProductDelete(
  db: DeleteDb,
  tenantId: string,
  ids: readonly string[],
  nameById: ReadonlyMap<string, string>,
): Promise<ProductDeletePlan> {
  const idList = [...ids];
  const activeGroups: Array<{ productId: string | null }> = await db.orderItem.groupBy({
    by: ["productId"],
    where: activeOrderItemWhere(idList),
  });
  const activeIds = new Set(
    activeGroups.map((g) => g.productId).filter((id): id is string => !!id),
  );

  const skipped: BulkDeleteSkip[] = [];
  const remaining: string[] = [];
  for (const id of idList) {
    if (activeIds.has(id)) {
      skipped.push({
        id,
        code: API_ERROR_CODES.PRODUCT_HAS_ACTIVE_ORDER_ITEMS,
        reason: `${nameById.get(id) ?? id} has active order items and cannot be deleted`,
      });
      continue;
    }
    remaining.push(id);
  }
  if (remaining.length === 0) return { skipped, softIds: [], hardIds: [] };

  const referencedIds = new Set<string>();
  const dependentModels: Array<{
    groupBy: (args: unknown) => Promise<Array<{ productId: string | null }>>;
  }> = [
    db.orderItem,
    db.invoiceItem,
    db.stockMovement,
    db.vendorBillItem,
    db.purchaseOrderItem,
    db.estimateItem,
    db.returnItem,
    db.recurringInvoiceItem,
    db.orderTemplateItem,
    db.deliveryMutation,
    db.stockLot,
    // #2717 M2: a product a recipe names (RESTRICT FKs) is referenced - soft-delete, never P2003.
    ...recipeReferenceGroupers(db),
  ];
  for (const model of dependentModels) {
    // eslint-disable-next-line no-await-in-loop -- one bounded grouped query per table
    const groups = await model.groupBy({
      by: ["productId"],
      where: { productId: { in: remaining } },
    });
    for (const group of groups) if (group.productId) referencedIds.add(group.productId);
    // Every remaining id is already known to be referenced - the outcome cannot change.
    if (referencedIds.size === remaining.length) break;
  }

  let softIds = remaining.filter((id) => referencedIds.has(id));
  let hardIds = remaining.filter((id) => !referencedIds.has(id));

  // B1212: a product that still has variants is never hard-deleted. The variants' parent link is SET NULL on
  // delete, so they would fall back to standalone products and could collide with another product of the same
  // name (a unique violation). A parent keeps (or archives) its variants: refused while one of them stays
  // active, archived when every variant that stays is already inactive or is archived in this same batch, and
  // only hard-deleted when ALL its variants are hard-deleted with it.
  const variantRows: Array<{ id: string; parentProductId: string | null; isActive: boolean }> =
    await db.product.findMany({
      where: { tenantId, parentProductId: { in: remaining } },
      select: { id: true, parentProductId: true, isActive: true },
    });
  if (variantRows.length > 0) {
    const hardSet = new Set(hardIds);
    const inBatch = new Set(remaining);
    const refused = new Set<string>();
    const forceSoft = new Set<string>();
    for (const v of variantRows) {
      const parentId = v.parentProductId;
      if (!parentId || hardSet.has(v.id)) continue; // goes away with its parent
      const archivedHere = inBatch.has(v.id) && !hardSet.has(v.id);
      if (v.isActive && !archivedHere) refused.add(parentId);
      else forceSoft.add(parentId);
    }
    for (const id of refused) {
      skipped.push({
        id,
        code: API_ERROR_CODES.FAMILY_HAS_ACTIVE_VARIANTS,
        reason: `${nameById.get(id) ?? id} has variants that are still active; delete or archive them first`,
      });
    }
    softIds = softIds.filter((id) => !refused.has(id));
    hardIds = hardIds.filter((id) => !refused.has(id));
    for (const id of forceSoft) {
      if (refused.has(id) || !hardIds.includes(id)) continue;
      hardIds = hardIds.filter((h) => h !== id);
      softIds.push(id);
    }
  }
  return { skipped, softIds, hardIds };
}

/**
 * Lock the product rows a delete will decide on, in the ONE house order of every stock writer: the targets AND the
 * families of the targets in a single ranked statement (`lockProductsForStock`: family role first, then recipe
 * products, then the rest, id order inside a rank), so a delete can never invert against a count commit, a receive or
 * a sale. The pre-lock read only chooses WHICH family rows to add; nothing is decided on it (L-239). FOR UPDATE
 * conflicts with the KEY SHARE lock a foreign-key insert (an order or invoice line, a stock movement) takes on the
 * product row, so a sale either committed before this point (the re-classification sees it) or waits until the
 * delete is over. The lock wait is bounded (STOCK_LOCK_TIMEOUT): a caller wraps the tx in `retryStockTx`.
 */
export async function lockProductsForDelete(
  tx: CatalogTx,
  tenantId: string,
  ids: readonly string[],
): Promise<void> {
  const targets = Array.from(new Set(ids));
  if (targets.length === 0) return;
  const children: Array<{ parentProductId: string | null }> = await tx.product.findMany({
    where: { tenantId, id: { in: targets }, parentProductId: { not: null } },
    select: { parentProductId: true },
  });
  const locked = new Set(targets);
  for (const c of children) if (c.parentProductId) locked.add(c.parentProductId);
  await lockProductsForStock(tx, tenantId, locked);
}

export interface ProductDeleteOutcome {
  deleted: number;
  softDeleted: number;
  skipped: BulkDeleteSkip[];
}

/**
 * The whole bulk delete, inside the caller's transaction. Order (house): code advisory locks of the products that
 * look referenced, product rows FOR UPDATE, THEN the authoritative classification, then the writes. `preSoftIds` is the
 * unlocked pre-read's soft set; a product that turns referenced only after the locks keeps its codes unlocked, so
 * it is refused with the delete-conflict 409 rather than released late (an inverted lock order).
 */
export async function applyProductDelete(
  tx: CatalogTx,
  input: {
    tenantId: string;
    ids: readonly string[];
    nameById: ReadonlyMap<string, string>;
    preSoftIds: readonly string[];
  },
): Promise<ProductDeleteOutcome> {
  const { tenantId, ids, nameById, preSoftIds } = input;
  // SA-603a: an archived product releases its codes. ONE sorted lock call over EVERY soft-deleted product's codes
  // BEFORE the rows are locked (Opus #2860 r2).
  const lockedCodes =
    preSoftIds.length > 0 ? await lockCodesOfProducts(tx, tenantId, preSoftIds) : new Set<string>();
  await lockProductsForDelete(tx, tenantId, ids);
  const plan = await planProductDelete(tx, tenantId, ids, nameById);

  const preSoft = new Set(preSoftIds);
  for (const id of plan.softIds) {
    if (preSoft.has(id)) continue;
    // eslint-disable-next-line no-await-in-loop -- only a product that became referenced during the lock wait
    const codes = await peekProductCodes(tx, tenantId, id);
    if (codes.some((c) => c.trim().length > 0 && !lockedCodes.has(c)))
      throw productDeleteConflict();
  }

  for (const productId of [...plan.softIds].sort()) {
    // eslint-disable-next-line no-await-in-loop
    await releaseProductCodes(tx, { tenantId, productId, lockedCodes });
  }
  if (plan.softIds.length > 0) {
    await tx.product.updateMany({ where: { id: { in: plan.softIds } }, data: { isActive: false } });
  }
  if (plan.hardIds.length > 0) {
    // Only rows that are configuration of the product itself go with it. Every record that names a product (order,
    // invoice, stock, bill, estimate, return, template, recipe lines) made it soft above, and none is written here.
    await tx.customerPrice.deleteMany({ where: { productId: { in: plan.hardIds } } });
    await tx.productMapping.deleteMany({ where: { productId: { in: plan.hardIds } } });
    await tx.product.deleteMany({ where: { id: { in: plan.hardIds } } });
  }
  return {
    deleted: plan.hardIds.length,
    softDeleted: plan.softIds.length,
    skipped: plan.skipped,
  };
}
