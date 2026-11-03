import { ConflictException } from "@nestjs/common";
import { resolveStoredLinePack } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * SA-841 (B207): each product's LIVE pack, as a map, for `foldMergeItems`. One batched, tenant-scoped read of the
 * stored + incoming products. Read-only: it writes no line and decides no line's factor on its own; the stored-line
 * merge reads it ONLY for a line with no pack of its own (SA-104a(4)) and as the SA-124e(3) price basis.
 */
export async function loadLiveUnitsPerBoxByProduct(
  db: {
    product: {
      findMany: (args: unknown) => Promise<Array<{ id: string; unitsPerBox: number | null }>>;
    };
  },
  productIds: readonly string[],
): Promise<Map<string, number>> {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await db.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, unitsPerBox: true },
  });
  return new Map(rows.map((product) => [product.id, Number(product.unitsPerBox ?? 0)]));
}

/** The stored line fields `resolveStoredLinePack` reads (a Prisma `orderItem` row, Decimals and all). */
export interface StoredSplitLine {
  productId: string | null;
  qty: unknown;
  boxes: unknown;
  pieces: unknown;
  unitsPerBox?: unknown;
  unitPrice: unknown;
  subtotal: unknown;
  promoFreeUnits?: unknown;
}

/**
 * SA-1097 (L-332): the pack a STORED box-split line was sold in, for an edit that is about to re-split and re-price it.
 * `pack` is the pack to split at (0 = none), `soldWithNoPack` is true for a line sold with no pack at all (it keeps its
 * stored shape - boxes = qty, no pieces, no snapshot - and prices as qty x price). A line whose own snapshot, split and
 * stored money cannot say is refused with STORED_LINE_PACK_UNREADABLE (409) before anything is written. Today's product
 * pack is read here, once, only as the CANDIDATE the stored money has to vouch for.
 */
export async function storedLinePackForEdit(
  db: Parameters<typeof loadLiveUnitsPerBoxByProduct>[0],
  line: StoredSplitLine,
): Promise<{ pack: number; soldWithNoPack: boolean }> {
  const snapshot = Number(line.unitsPerBox ?? 0);
  if (snapshot > 1) return { pack: snapshot, soldWithNoPack: false };
  const livePack = line.productId
    ? (await loadLiveUnitsPerBoxByProduct(db, [line.productId])).get(line.productId)
    : undefined;
  const stored = resolveStoredLinePack({
    qty: Number(line.qty),
    boxes: line.boxes == null ? null : Number(line.boxes),
    pieces: line.pieces == null ? null : Number(line.pieces),
    unitsPerBox: line.unitsPerBox == null ? null : snapshot,
    unitPrice: Number(line.unitPrice),
    subtotal: Number(line.subtotal),
    freeUnits: Number(line.promoFreeUnits ?? 0),
    livePack,
  });
  if (!stored.ok) {
    throw new ConflictException({
      code: API_ERROR_CODES.STORED_LINE_PACK_UNREADABLE,
      message:
        "This line's pack size can't be read from the sale, so its total was not changed. Use a return or a credit note to correct the amount.",
    });
  }
  return { pack: stored.pack ?? 0, soldWithNoPack: stored.pack === null };
}
