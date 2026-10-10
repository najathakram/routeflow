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

const CI_TOBACCO = { equals: "Tobacco", mode: "insensitive" };

/**
 * The per-tenant read glue of the backfill: loads the Tobacco type, the flagged/member products and
 * the open recipes touching the link candidates via `db` (a Prisma client), then returns EXACTLY
 * `{ tenant, ...planTobaccoLink(...) }` - nothing is re-added after planning.
 */
export async function planTobaccoTenant(db, tenant) {
  const tobaccoCat = await db.trackedCategory.findFirst({
    where: { tenantId: tenant.id, name: CI_TOBACCO },
    select: { id: true, name: true, active: true },
  });
  const products = await db.product.findMany({
    where: {
      tenantId: tenant.id,
      OR: [{ isTobacco: true }, ...(tobaccoCat ? [{ trackedCategoryId: tobaccoCat.id }] : [])],
    },
    select: {
      id: true,
      name: true,
      isTobacco: true,
      trackedCategoryId: true,
      trackedCategory: { select: { name: true } },
    },
  });
  // SA-587b: a would-be link product in an open (DRAFT/ACTIVE) recipe is skipped, counted only.
  const linkCandidates = tobaccoLinkCandidates(products);
  const openRecipes =
    linkCandidates.length > 0
      ? await db.recipe.findMany({
          where: { tenantId: tenant.id, ...openRecipeWhereAny(linkCandidates.map((p) => p.id)) },
          select: {
            status: true,
            productId: true,
            familyProductId: true,
            components: { select: { componentProductId: true } },
          },
        })
      : [];
  return { tenant, ...planTobaccoLink({ tobaccoCat, products, openRecipes }) };
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
