import { BadRequestException, ConflictException } from "@nestjs/common";
import { normalizeBoxesPieces, resolveStoredLinePack } from "@routeflow/pricing";
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

/**
 * The pack `updateOrderItems` splits a line at: a STORED box-split line reads the pack it was sold in
 * (`storedLinePackForEdit`); a plain line whose payload adds a split takes the write moment's (live) pack.
 */
export async function packForLineEdit(
  db: Parameters<typeof loadLiveUnitsPerBoxByProduct>[0],
  line: StoredSplitLine,
  editHasSplit: boolean,
): Promise<{ pack: number | null; soldWithNoPack: boolean; stored: boolean }> {
  if (
    line.productId &&
    (line.boxes != null || line.pieces != null) &&
    !(Number(line.unitsPerBox ?? 0) > 1)
  ) {
    const stored = await storedLinePackForEdit(db, line);
    return { pack: stored.pack || null, soldWithNoPack: stored.soldWithNoPack, stored: true };
  }
  const own = line.unitsPerBox == null ? null : Number(line.unitsPerBox);
  if (own == null && line.productId && editHasSplit) {
    const live = (await loadLiveUnitsPerBoxByProduct(db, [line.productId])).get(line.productId);
    return { pack: live || null, soldWithNoPack: false, stored: false };
  }
  return { pack: own, soldWithNoPack: false, stored: false };
}

/** A qty typed for a line sold with no pack: whole (`boxes` is whole, so the shape can't hold a fraction) or refused. */
export function noPackEditQty(qty: number): number {
  if (!Number.isInteger(qty)) {
    throw new BadRequestException({
      code: API_ERROR_CODES.INVALID_LINE_SPLIT,
      message: "This line is sold in whole units. Enter a whole number.",
    });
  }
  return Math.max(0, qty);
}

type EditSplitItem = { qty?: number | null; boxes?: number | null; pieces?: number | null };

/**
 * SA-1097 A-2/A-3: the qty + split an edit writes to a STORED split line with no snapshot, at the pack it was sold in
 * (`pack`; `soldWithNoPack` = 1 and keeps boxes = qty). A payload naming BOTH qty and a split must agree at that pack
 * (QTY_SPLIT_MISMATCH, nothing written - never normalized: the web's pre-fix 5-case payload would otherwise write qty 60);
 * a split alone normalizes at the pack; no split re-splits qty.
 */
export function storedLineEditShape(
  item: EditSplitItem,
  heldQty: unknown,
  pack: number | null,
  soldWithNoPack: boolean,
): { qty: number; boxes: number; pieces: number } {
  const splitSent = (item.boxes ?? 0) > 0 || (item.pieces ?? 0) > 0;
  const factor = soldWithNoPack ? 1 : Number(pack ?? 0);
  if (
    splitSent &&
    item.qty != null &&
    (item.boxes ?? 0) * factor + (item.pieces ?? 0) !== item.qty
  ) {
    throw new BadRequestException({
      code: API_ERROR_CODES.QTY_SPLIT_MISMATCH,
      message: "The quantity and the box split of a line disagree. Review the line and try again.",
    });
  }
  if (soldWithNoPack) {
    const qty = noPackEditQty(
      item.qty ?? (splitSent ? (item.boxes ?? 0) + (item.pieces ?? 0) : Number(heldQty)),
    );
    return { qty, boxes: qty, pieces: 0 };
  }
  const split = normalizeBoxesPieces({
    boxes: splitSent && item.qty == null ? item.boxes : undefined,
    pieces: splitSent && item.qty == null ? item.pieces : undefined,
    qty: item.qty ?? Number(heldQty),
    unitsPerBox: factor,
  });
  return { qty: split.qty, boxes: split.boxes ?? 0, pieces: split.pieces ?? 0 };
}
