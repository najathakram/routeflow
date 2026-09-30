import type { Prisma } from "@prisma/client";
import { readFamilyPriceMode } from "../products/family-price";
import { syncLineCompositions } from "./line-composition";
import { recipeSnapshotPort } from "./recipe-snapshot.adapter";

/**
 * #2717 M3: the ONE call every order writer makes, inside its own transaction, after it has
 * written order lines: bring the frozen FIXED compositions of the order's lines in step with the
 * rows just written (I12 in the writing tx). While the tenant's `mixed_packs` mode is not `on`
 * (no config, an unreadable config, no tenant) it reads and writes NOTHING, so every existing
 * tenant's writes are byte-identical to before.
 */
export async function syncOrderLineCompositions(
  tx: Prisma.TransactionClient,
  orderId: string,
  tenantId: string | null,
  featureConfig: { getEffectiveMode(tenantId: string, key: string): Promise<string> } | undefined,
): Promise<void> {
  if ((await readFamilyPriceMode(featureConfig, tenantId)) !== "on" || !tenantId) return;
  const lines = await tx.orderItem.findMany({ where: { orderId }, select: { id: true } });
  await syncLineCompositions(
    tx,
    lines.map((l) => l.id),
    { tenantId, enabled: true, port: recipeSnapshotPort(tx, tenantId) },
  );
}

/**
 * #2717 M3: the recipe stamp a moved or created line carries — `{}` for a plain line, so a tenant
 * that never composes writes exactly the keys it always did.
 */
export function compositionStampOf(x: {
  compositionMode?: string | null;
  recipeId?: string | null;
  recipeVersion?: number | null;
}): { compositionMode?: "FIXED"; recipeId?: string | null; recipeVersion?: number | null } {
  if (x.compositionMode !== "FIXED") return {};
  return {
    compositionMode: "FIXED",
    recipeId: x.recipeId ?? null,
    recipeVersion: x.recipeVersion ?? null,
  };
}
