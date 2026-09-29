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

/** Products flagged tobacco that point at no category: the would-be `link` set (pre-recipe-lock). */
export function tobaccoLinkCandidates(products) {
  return products.filter((p) => p.isTobacco && p.trackedCategoryId == null);
}

/**
 * Pure plan for one tenant (SA-587b): `products` = the flagged/member candidates, `tobaccoCat` =
 * the tenant's Tobacco type or null, `openRecipes` = open recipes touching the link candidates.
 * `link` = candidates in no open recipe; `recipeLocked` = the rest (skipped, never written).
 */
export function planTobaccoLink({ tobaccoCat, products, openRecipes }) {
  const { free: link, recipeLocked } = partitionRecipeLocked(
    tobaccoLinkCandidates(products),
    lockedProductIds(openRecipes),
  );
  return {
    tobaccoCat,
    link,
    recipeLocked,
    // Flagged but assigned to a DIFFERENT type: never auto-moved, reported only.
    conflicts: products.filter(
      (p) => p.isTobacco && p.trackedCategoryId != null && p.trackedCategoryId !== tobaccoCat?.id,
    ),
    // Members of the Tobacco type missing the mirror flag -> set it.
    flag: products.filter(
      (p) => !p.isTobacco && tobaccoCat && p.trackedCategoryId === tobaccoCat.id,
    ),
    // Create the type only when a FREE link row needs it (all-conflict / all-locked tenants get none).
    createCategory: !tobaccoCat && link.length > 0,
  };
}

/** The writes of a plan, on a transaction client `tx`: ONLY `plan.link` and `plan.flag` ids. */
export async function applyTobaccoPlan(tx, plan) {
  let catId = plan.tobaccoCat?.id;
  if (plan.createCategory) {
    const created = await tx.trackedCategory.create({
      data: {
        tenantId: plan.tenant.id,
        name: "Tobacco",
        taxType: "NONE",
        requiresLicense: false,
        reportTemplate: "CA_CDTFA",
        reportCadence: "MONTHLY",
        invoiceTreatment: "SEPARATE_INVOICE",
        active: true,
      },
      select: { id: true },
    });
    catId = created.id;
  }
  if (plan.link.length > 0 && catId) {
    await tx.product.updateMany({
      where: { id: { in: plan.link.map((p) => p.id) } },
      data: { trackedCategoryId: catId },
    });
  }
  if (plan.flag.length > 0) {
    await tx.product.updateMany({
      where: { id: { in: plan.flag.map((p) => p.id) } },
      data: { isTobacco: true },
    });
  }
}

/** `--all-tenants` totals; recipeLocked is a COUNT only. */
export function summarizePlans(plans) {
  let writes = 0;
  let conflicts = 0;
  let recipeLocked = 0;
  for (const p of plans) {
    writes += p.link.length + p.flag.length + (p.createCategory ? 1 : 0);
    conflicts += p.conflicts.length;
    recipeLocked += p.recipeLocked.length;
  }
  return { writes, conflicts, recipeLocked };
}
