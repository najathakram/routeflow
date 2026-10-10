import { Prisma } from "@prisma/client";
import { lockFamilyRow } from "./family-price";
import { lockProductRow, type CatalogTx } from "./product-catalog-sync";
import { countLockedProducts, openRecipeWhereAny, recipeCategoryLocked } from "./recipe-rules";

/**
 * SA-587a: the I6 guard for a bulk writer of `Product.trackedCategoryId` / `trackedSubcategoryId`
 * (tracked-categories assign/unassign) — the sibling of `lockAndAssertRecipeGuards`, which covers the
 * single-product edit. Two steps, both inside the caller's transaction:
 *
 *   1. `lockProductsForCategoryWrite` takes the HOUSE LOCK ORDER (product-catalog-sync.ts): the
 *      family rows (the parents of the targets and the families of the open recipes they sit in, id
 *      order), then the recipe-product rows, then every target row FOR UPDATE in id order. The
 *      pre-lock reads here only choose WHICH rows to lock; nothing is decided on them (L-239).
 *   2. `assertNoOpenRecipe` decides AFTER the locks, on a fresh read of the rows that would move:
 *      409 RECIPE_CATEGORY_LOCKED, so the caller has written nothing.
 */
export async function lockProductsForCategoryWrite(
  tx: CatalogTx,
  tenantId: string,
  productIds: string[],
): Promise<void> {
  const ids = Array.from(new Set(productIds)).sort();
  if (ids.length === 0) return;
  const [recipes, products]: [
    Array<{ productId: string; familyProductId: string }>,
    Array<{ parentProductId: string | null }>,
  ] = await Promise.all([
    tx.recipe.findMany({
      where: openRecipeWhereAny(ids),
      select: { productId: true, familyProductId: true },
    }),
    tx.product.findMany({
      where: { id: { in: ids } },
      select: { id: true, parentProductId: true },
    }),
  ]);
  const families = new Set<string>();
  for (const r of recipes) families.add(r.familyProductId);
  for (const p of products) if (p.parentProductId) families.add(p.parentProductId);
  for (const familyId of Array.from(families).sort()) {
    // Serial by design: id order, one lock at a time.
    // eslint-disable-next-line no-await-in-loop
    await lockFamilyRow(tx, tenantId, familyId);
  }
  for (const productId of Array.from(new Set(recipes.map((r) => r.productId))).sort()) {
    // eslint-disable-next-line no-await-in-loop
    await lockProductRow(tx, tenantId, productId);
  }
  await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "tenantId" = ${tenantId} AND "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`;
}

/** After the locks: 409 RECIPE_CATEGORY_LOCKED when any of `movingIds` sits in a DRAFT/ACTIVE recipe. */
export async function assertNoOpenRecipe(tx: CatalogTx, movingIds: string[]): Promise<void> {
  if (movingIds.length === 0) return;
  const open: { id: string } | null = await tx.recipe.findFirst({
    where: openRecipeWhereAny(movingIds),
    select: { id: true },
  });
  if (!open) return;
  // Refusal path only (post-lock, in the same tx): count how many of the movers are locked.
  const recipes: Array<{
    productId: string;
    familyProductId: string;
    components: Array<{ componentProductId: string }>;
  }> = await tx.recipe.findMany({
    where: openRecipeWhereAny(movingIds),
    select: {
      productId: true,
      familyProductId: true,
      components: { select: { componentProductId: true } },
    },
  });
  throw recipeCategoryLocked(Math.max(1, countLockedProducts(movingIds, recipes)));
}
