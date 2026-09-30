/**
 * #2717 M2 (test 13): the recipe tables reference Product with RESTRICT foreign keys, so a product
 * that a recipe names — as the recipe product, the family, or a component — must be treated as
 * REFERENCED by `ProductsService.bulkDelete`/`clearAll` (soft-deleted, never hard-deleted), or the
 * hard delete throws P2003. The three adapters expose the same `groupBy(by: productId)` surface
 * the delete classifier already reads from its other dependent tables.
 */
type Grouper = { groupBy: (args: unknown) => Promise<Array<{ productId: string | null }>> };

interface RecipeReferenceDb {
  recipe: { groupBy: (args: unknown) => Promise<unknown[]> };
  recipeComponent: { groupBy: (args: unknown) => Promise<unknown[]> };
}

function idsOf(args: unknown): string[] {
  const where = (args as { where?: { productId?: { in?: unknown } } })?.where;
  const list = where?.productId?.in;
  return Array.isArray(list)
    ? list.filter((v): v is string => typeof v === "string" && v !== "")
    : [];
}

function adapter(
  run: (ids: string[]) => Promise<unknown[]>,
  column: "productId" | "familyProductId" | "componentProductId",
): Grouper {
  return {
    groupBy: async (args) => {
      const ids = idsOf(args);
      if (ids.length === 0) return [];
      const rows = (await run(ids)) as Array<Record<string, string | null>>;
      return rows.map((r) => ({ productId: r[column] ?? null }));
    },
  };
}

export function recipeReferenceGroupers(db: RecipeReferenceDb): Grouper[] {
  return [
    adapter(
      (ids) => db.recipe.groupBy({ by: ["productId"], where: { productId: { in: ids } } }),
      "productId",
    ),
    adapter(
      (ids) =>
        db.recipe.groupBy({ by: ["familyProductId"], where: { familyProductId: { in: ids } } }),
      "familyProductId",
    ),
    adapter(
      (ids) =>
        db.recipeComponent.groupBy({
          by: ["componentProductId"],
          where: { componentProductId: { in: ids } },
        }),
      "componentProductId",
    ),
  ];
}
