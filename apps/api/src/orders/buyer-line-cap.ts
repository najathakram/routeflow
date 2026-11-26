import { BadRequestException } from "@nestjs/common";
import { buyerLineOverCap } from "@routeflow/pricing";
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

/** Refuses (400 BUYER_LINE_QTY_OVER_MAX, nothing written) when any line passes the cap and rises. A pure check. */
export function assertBuyerLinesWithinCap(lines: ReadonlyArray<BuyerCapLine>): void {
  const over = lines.filter((l) => buyerLineOverCap(l.pieces, l.storedPieces ?? 0));
  if (over.length === 0) return;
  throw new BadRequestException({
    code: API_ERROR_CODES.BUYER_LINE_QTY_OVER_MAX,
    message: BUYER_LINE_QTY_OVER_MAX_MESSAGE,
    productIds: [...new Set(over.map((l) => l.productId).filter((id): id is string => !!id))],
  });
}
