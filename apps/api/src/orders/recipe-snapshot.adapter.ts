import type { Prisma } from "@prisma/client";
import { liveBarcodeRows } from "../products/product-barcode-rules";
import type { ComponentProductFacts, RecipeSnapshotPort } from "./line-composition";

/**
 * #2717 M3 (I11): the ONE file where a document write reads Recipe / RecipeComponent rows. The
 * ACTIVE recipe is `Recipe.activeFor = productId`; its components are read by recipeId, and a
 * non-DRAFT recipe's components never change (SA-579), so a concurrent activation cannot mix
 * versions. Everything else about the recipe is copied onto the line and read from there.
 */
export function recipeSnapshotPort(
  tx: Prisma.TransactionClient,
  tenantId: string,
): RecipeSnapshotPort {
  const select = {
    id: true,
    version: true,
    unitsPerPack: true,
    components: {
      select: { componentProductId: true, qty: true },
      orderBy: { position: "asc" as const },
    },
  };
  const snap = (r: {
    id: string;
    version: number;
    unitsPerPack: number;
    components: Array<{ componentProductId: string; qty: number }>;
  }) => ({
    recipeId: r.id,
    version: r.version,
    unitsPerPack: r.unitsPerPack,
    comps: r.components.map((c) => ({ componentProductId: c.componentProductId, qty: c.qty })),
  });
  return {
    async activeRecipeFor(productId) {
      const r = await tx.recipe.findFirst({ where: { tenantId, activeFor: productId }, select });
      return r ? snap(r) : null;
    },
    async recipeById(recipeId) {
      const r = await tx.recipe.findFirst({ where: { tenantId, id: recipeId }, select });
      return r ? snap(r) : null;
    },
    async productFacts(ids) {
      const rows = await tx.product.findMany({
        where: { tenantId, id: { in: ids } },
        select: {
          id: true,
          name: true,
          sku: true,
          unitSku: true,
          barcode: true,
          unitsPerBox: true,
          barcodes: { select: { code: true, symbology: true, level: true, primaryFor: true } },
        },
      });
      // SA-603a: a RELEASED barcode row (code NULL) is not a live code — the snapshot never carries one.
      return new Map(
        rows.map((p): [string, ComponentProductFacts] => [
          p.id,
          { ...p, barcodes: liveBarcodeRows(p.barcodes) },
        ]),
      );
    },
  };
}
