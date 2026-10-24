import type { Prisma } from "@prisma/client";

/**
 * #2717 M3 (SA-591 b, SA-579 case 8, I11): updateOrderItems' replace-all paths delete every line
 * and re-create it. A line that SURVIVES the edit must keep the composition it was created with:
 * its stored recipeId/recipeVersion/compositionMode and its stored component rows, which the
 * order-wide sync then rescales from their own per-box counts (no Recipe read). Only a line with
 * no counterpart in the pre-edit order is new, and only it resolves the ACTIVE recipe.
 *
 * `captureCompositionCarry` snapshots the pre-edit stamps and rows BEFORE the delete;
 * `carry.restore` is called with each re-created line. Pairing: a folded payload's `sourceLineId`
 * names its line exactly; otherwise the k-th incoming line of a product takes the k-th pre-edit
 * line of that product (position order). That ordinal pairing is only trusted when every pre-edit
 * line of the product carries the SAME stamp (any pairing then yields the right version) or the
 * incoming count equals the pre-edit count; otherwise no version is guessed.
 */
export interface PreEditLine {
  id: string;
  productId?: string | null;
  status?: string | null;
  position?: number | null;
  compositionMode?: string | null;
  recipeId?: string | null;
  recipeVersion?: number | null;
}

export interface CompositionCarry {
  restore(
    tx: Prisma.TransactionClient,
    newLineId: string,
    item: { productId?: string | null; sourceLineId?: string },
  ): Promise<void>;
}

interface Carried {
  recipeId: string | null;
  recipeVersion: number | null;
  rows: Array<{
    tenantId: string;
    componentProductId: string;
    qty: number;
    name: string;
    unitSku: string | null;
    unitBarcode: string | null;
    barcodeSymbology: unknown;
    displayUnitPrice4: unknown;
    position: number;
  }>;
}

const NOTHING_TO_CARRY: CompositionCarry = { restore: async () => undefined };

/** Stamp the re-created line and copy the stored rows onto it (the sync rescales them next). */
export async function restoreCarriedComposition(
  tx: Prisma.TransactionClient,
  newLineId: string,
  carried: Carried,
): Promise<void> {
  await tx.orderItem.update({
    where: { id: newLineId },
    data: {
      compositionMode: "FIXED",
      recipeId: carried.recipeId,
      recipeVersion: carried.recipeVersion,
    },
  });
  if (carried.rows.length === 0) return;
  await tx.orderItemComponent.createMany({
    data: carried.rows.map((r) => ({ ...r, orderItemId: newLineId })) as never,
  });
}

const stampKey = (l: PreEditLine) =>
  l.compositionMode === "FIXED" ? `${l.recipeId}:${l.recipeVersion}` : "plain";

/** Read the pre-edit composition. Issues no query at all while no pre-edit line is FIXED. */
export async function captureCompositionCarry(
  tx: Prisma.TransactionClient,
  lines: PreEditLine[],
  incoming: Array<{ productId?: string | null; sourceLineId?: string }>,
): Promise<CompositionCarry> {
  const live = lines.filter((l) => l.productId && l.status !== "CANCELLED");
  const fixed = live.filter((l) => l.compositionMode === "FIXED");
  if (fixed.length === 0) return NOTHING_TO_CARRY;
  const stored = await tx.orderItemComponent.findMany({
    where: { orderItemId: { in: fixed.map((l) => l.id) } },
    orderBy: { position: "asc" },
  });
  const carried = new Map<string, Carried>(
    fixed.map((l) => [
      l.id,
      {
        recipeId: l.recipeId ?? null,
        recipeVersion: l.recipeVersion ?? null,
        rows: stored
          .filter((r) => r.orderItemId === l.id)
          .map((r) => ({
            tenantId: r.tenantId,
            componentProductId: r.componentProductId,
            qty: r.qty,
            name: r.name,
            unitSku: r.unitSku,
            unitBarcode: r.unitBarcode,
            barcodeSymbology: r.barcodeSymbology,
            displayUnitPrice4: r.displayUnitPrice4,
            position: r.position,
          })),
      },
    ]),
  );
  // A line NAMED by an entry's `sourceLineId` is claimed by that entry alone: it never sits in the ordinal
  // queue, so an id-less entry (a split's new half, a new add) placed before it cannot take its stamp.
  const named = new Map<string, PreEditLine>();
  const claimedIds = new Set(incoming.map((i) => i.sourceLineId).filter(Boolean) as string[]);
  const queues = new Map<string, PreEditLine[]>();
  const byPosition = [...live].sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9));
  for (const l of byPosition) {
    if (claimedIds.has(l.id)) named.set(l.id, l);
    else queues.set(l.productId!, [...(queues.get(l.productId!) ?? []), l]);
  }
  const incomingBy = new Map<string, number>();
  for (const it of incoming) {
    if (it.productId && !(it.sourceLineId && named.has(it.sourceLineId))) {
      incomingBy.set(it.productId, (incomingBy.get(it.productId) ?? 0) + 1);
    }
  }
  // Decided ONCE, from the unclaimed pre-edit queue (it shrinks as lines are taken).
  const ordinalOk = new Map<string, boolean>(
    [...queues].map(([pid, q]) => [
      pid,
      new Set(q.map(stampKey)).size <= 1 || q.length === (incomingBy.get(pid) ?? 0),
    ]),
  );
  return {
    restore: async (txn, newLineId, item) => {
      if (!item.productId) return;
      const q = queues.get(item.productId) ?? [];
      let taken: PreEditLine | undefined;
      if (item.sourceLineId) {
        taken = named.get(item.sourceLineId);
        if (taken) named.delete(taken.id);
        else {
          // not announced in `incoming` (a caller that names it only at restore): the queue holds it
          const at = q.findIndex((l) => l.id === item.sourceLineId);
          if (at >= 0) [taken] = q.splice(at, 1);
        }
        if (!taken || taken.productId !== item.productId) return;
      } else {
        if (!ordinalOk.get(item.productId) || q.length === 0) return;
        [taken] = q.splice(0, 1);
      }
      const c = carried.get(taken.id);
      if (c) await restoreCarriedComposition(txn, newLineId, c);
    },
  };
}
