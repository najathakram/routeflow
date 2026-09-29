/**
 * SA-587b (#2717 M2): plain-JS mirror of the API's "open recipe" predicate for standalone scripts
 * that run under bare `node` and cannot import TypeScript. A product in a non-RETIRED recipe (as the
 * recipe product, the family, or a component) must not have its tracked category changed.
 * Kept in lock-step with `openRecipeWhereAny` / `OPEN_RECIPE_STATUS` in
 * `src/products/recipe-rules.ts` by `backfill-tobacco-recipe-locked-script.spec.ts`.
 */
export const OPEN_RECIPE_STATUSES = ["DRAFT", "ACTIVE"];

/** Prisma `where` for recipes touching any of `productIds` in any role. */
export function openRecipeWhereAny(productIds) {
  return {
    status: { in: OPEN_RECIPE_STATUSES },
    OR: [
      { productId: { in: productIds } },
      { familyProductId: { in: productIds } },
      { components: { some: { componentProductId: { in: productIds } } } },
    ],
  };
}

/** Set of every product id held by an open recipe (any role). RETIRED recipes never lock. */
export function lockedProductIds(recipes) {
  const ids = new Set();
  for (const r of recipes) {
    if (!OPEN_RECIPE_STATUSES.includes(r.status)) continue;
    ids.add(r.productId);
    ids.add(r.familyProductId);
    for (const c of r.components ?? []) ids.add(c.componentProductId);
  }
  return ids;
}

/** Split products into those free to change and those an open recipe locks. */
export function partitionRecipeLocked(products, lockedIdSet) {
  const free = [];
  const recipeLocked = [];
  for (const p of products) (lockedIdSet.has(p.id) ? recipeLocked : free).push(p);
  return { free, recipeLocked };
}
