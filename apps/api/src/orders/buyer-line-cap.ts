import { BadRequestException } from "@nestjs/common";
import { buyerCreateLinePieces, buyerLineOverCap } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * B1386 (SA-1285 section 1, words per SA-1299 A2): the buyer line cap on the server. Every CUSTOMER write path that
 * stores or files a line quantity (order edit, change request, order template) refuses a line whose PIECE total
 * would pass `BUYER_LINE_QTY_MAX`, unless that line already held more pieces (rise-only). The message names no
 * number: each client shows its own computed bound. `buyer-qty-writers.inventory.spec.ts` lists every CUSTOMER
 * quantity writer and the guard it uses, so a new one cannot skip this.
 */
export const BUYER_LINE_QTY_OVER_MAX_MESSAGE =
  "That's more than you can order on one line. Lower the quantity, or contact your supplier.";

export interface BuyerCapLine {
  productId?: string | null;
  /** The line's new piece total (`buyerLinePieces`). */
  pieces: number;
  /** The pieces the same line held before this write; 0 or absent for a new line. */
  storedPieces?: number;
}

/**
 * The lines that pass the cap AND rise above what they held (`buyerLineOverCap`, rise-only). Never throws: the ONE
 * "would this exceed the cap" check, shared by the order create / portal fold (`assertBuyerLinesWithinCap`, which
 * refuses) and the after-create sweep (`merge-fold-cap.ts`, which keeps the order apart because it cannot refuse).
 */
export function buyerLinesOverCap(lines: ReadonlyArray<BuyerCapLine>): BuyerCapLine[] {
  return lines.filter((l) => buyerLineOverCap(l.pieces, l.storedPieces ?? 0));
}

/** Refuses (400 BUYER_LINE_QTY_OVER_MAX, nothing written) when any line passes the cap and rises. A pure check. */
export function assertBuyerLinesWithinCap(lines: ReadonlyArray<BuyerCapLine>): void {
  const over = buyerLinesOverCap(lines);
  if (over.length === 0) return;
  throw new BadRequestException({
    code: API_ERROR_CODES.BUYER_LINE_QTY_OVER_MAX,
    message: BUYER_LINE_QTY_OVER_MAX_MESSAGE,
    productIds: [...new Set(over.map((l) => l.productId).filter((id): id is string => !!id))],
  });
}

/** A line of a buyer's new order or quote, as the DTO carries it (a plain `qty` counts PACKS). */
export interface BuyerCreateCapItem {
  productId?: string | null;
  qty?: number | null;
  boxes?: number | null;
  pieces?: number | null;
}

/**
 * B1386 (order CREATE, quote and the staff-JWT create for a CUSTOMER): the cap on the piece total the line will be BUILT
 * to (`buyerCreateLinePieces`, the same figure `OrdersService.create` stores), not on each DTO field alone. Every line
 * is a new line (`storedPieces` 0). A line with no `productId` (unlisted) is skipped here: a buyer's unlisted line is
 * refused by create itself. `packByProduct` is `loadLiveUnitsPerBoxByProduct` (the pack create reads for the same
 * product); a product it does not return counts as a pack of 1. Throws before anything is written or quoted.
 */
export function assertBuyerCreateItemsWithinCap(
  items: ReadonlyArray<BuyerCreateCapItem> | undefined,
  packByProduct: ReadonlyMap<string, number>,
): void {
  assertBuyerLinesWithinCap(
    (items ?? [])
      .filter((i) => !!i.productId)
      .map((i) => ({
        productId: i.productId,
        pieces: buyerCreateLinePieces({
          qty: i.qty,
          boxes: i.boxes,
          pieces: i.pieces,
          unitsPerBox: packByProduct.get(i.productId as string),
        }),
        storedPieces: 0,
      })),
  );
}
