import { ConflictException } from "@nestjs/common";
import { lockFamilyRow } from "./family-price";
import { lockProductRow, type CatalogTx } from "./product-catalog-sync";
import {
  openRecipeWhere,
  recipeCategoryLocked,
  recipeFamilyLocked,
  recipeInvalid,
} from "./recipe-rules";

/**
 * SA-584 B2 (a)/(c): the recipe guards of `ProductsService.update`, run INSIDE its transaction. While
 * a recipe is DRAFT or ACTIVE, the edits that would break it are refused:
 *   - a tracked category/subcategory change on any product in it (I6)      409 RECIPE_CATEGORY_LOCKED
 *   - re-parenting a COMPONENT (I2)                                         409 RECIPE_FAMILY_LOCKED
 *   - giving the recipe product or a family that has a recipe a parent (Q1) 409 RECIPE_INVALID
 *   - a `unitsPerBox` change on the family or the recipe product (Q10)      409 RECIPE_FAMILY_LOCKED
 * Nothing runs (no lock, no query) unless one of those fields actually changes.
 *
 * Lock order is the house order (product-catalog-sync.ts): the family rows this edit touches (the
 * current parent, the new parent, or, for a recipe product, its recipe's family), in id order,
 * THEN the product's own row — and only then the recipes are read. The recipe writers take the
 * family, the recipe product and the components FOR SHARE the same way, so whichever transaction
 * commits second sees the other (L-239): a re-parent that lands first makes the recipe's
 * re-validation fail; an activation that lands first makes this guard fail.
 */
export interface RecipeGuardInput {
  tenantId: string;
  id: string;
  existing: {
    parentProductId: string | null;
    unitsPerBox: number | null;
    trackedCategoryId: string | null;
    trackedSubcategoryId: string | null;
  };
  dto: { parentProductId?: string | null; unitsPerBox?: number | null };
  /** The post-write tracked category/subcategory the caller derived. */
  effective: { trackedCategoryId: string | null; trackedSubcategoryId: string | null };
}

const nul = <T>(v: T | null | undefined): T | null => (v === undefined ? null : v);

export async function lockAndAssertRecipeGuards(
  tx: CatalogTx,
  input: RecipeGuardInput,
): Promise<void> {
  const { tenantId, id, existing, dto, effective } = input;
  const parentWanted =
    dto.parentProductId !== undefined && nul(dto.parentProductId) !== nul(existing.parentProductId);
  const boxWanted =
    dto.unitsPerBox !== undefined && nul(dto.unitsPerBox) !== nul(existing.unitsPerBox);
  const categoryWanted =
    nul(effective.trackedCategoryId) !== nul(existing.trackedCategoryId) ||
    nul(effective.trackedSubcategoryId) !== nul(existing.trackedSubcategoryId);
  if (!parentWanted && !boxWanted && !categoryWanted) return;

  // 1. family rows, id order. A parentless product may be a recipe product: its family is on the recipe.
  // This PRE-lock read only chooses WHICH rows to lock; no refusal rests on it (SA-587).
  const preLockRecipe: { familyProductId: string } | null = existing.parentProductId
    ? null
    : await tx.recipe.findFirst({
        where: { productId: id, tenantId },
        orderBy: { version: "desc" },
        select: { familyProductId: true },
      });
  const familyIds = new Set<string>();
  if (existing.parentProductId) familyIds.add(existing.parentProductId);
  if (parentWanted && dto.parentProductId) familyIds.add(dto.parentProductId);
  if (preLockRecipe?.familyProductId) familyIds.add(preLockRecipe.familyProductId);
  familyIds.delete(id);
  for (const familyId of Array.from(familyIds).sort()) {
    // Serial by design: id order, one lock at a time.
    // eslint-disable-next-line no-await-in-loop
    await lockFamilyRow(tx, tenantId, familyId);
  }
  // 2. the product's own row, then what it is NOW (the pre-lock read may be stale).
  await lockProductRow(tx, tenantId, id);
  const fresh: { parentProductId: string | null; unitsPerBox: number | null } | null =
    await tx.product.findFirst({
      where: { id, tenantId },
      select: { parentProductId: true, unitsPerBox: true },
    });
  if (fresh && nul(fresh.parentProductId) !== nul(existing.parentProductId)) {
    throw new ConflictException(
      "This product was moved while you were editing it. Reload it and try again.",
    );
  }

  // 3. decide, after the locks — on what is read NOW (SA-587): a recipes.create for this product that
  // committed while we waited on its row lock must still make the adoption a 409.
  const ownRecipe: { id: string } | null =
    parentWanted && dto.parentProductId
      ? await tx.recipe.findFirst({ where: { productId: id, tenantId }, select: { id: true } })
      : null;
  if (categoryWanted) {
    const locked = await tx.recipe.findFirst({ where: openRecipeWhere(id), select: { id: true } });
    if (locked) throw recipeCategoryLocked();
  }
  if (!parentWanted && !boxWanted) return;
  const open: Array<{ productId: string; familyProductId: string }> = await tx.recipe.findMany({
    where: openRecipeWhere(id),
    select: { productId: true, familyProductId: true },
  });
  if (parentWanted) {
    if (dto.parentProductId) {
      if (ownRecipe) {
        throw recipeInvalid(
          "RECIPE_PRODUCT_HAS_PARENT",
          "A recipe product cannot become a variant of another product.",
          409,
        );
      }
      if (open.some((r) => r.familyProductId === id)) {
        throw recipeInvalid(
          "FAMILY_IS_VARIANT",
          "A family that has a recipe cannot become a variant of another product.",
          409,
        );
      }
    }
    if (open.some((r) => r.productId !== id && r.familyProductId !== id)) {
      throw recipeFamilyLocked("PARENT");
    }
  }
  if (boxWanted && open.some((r) => r.productId === id || r.familyProductId === id)) {
    throw recipeFamilyLocked("UNITS_PER_BOX");
  }
}
