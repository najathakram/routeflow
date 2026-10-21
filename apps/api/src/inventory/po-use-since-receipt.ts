import { ConflictException } from "@nestjs/common";
import { MovementType, Prisma } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { BILL_REVERTED_NOTE, BILL_VOID_SHORTFALL_NOTE, PO_REVERSAL_NOTE } from "./bill-revert";

/**
 * Row 645 (SA-814m): has any of a purchase order's received goods been USED since the receipt?
 *
 * Since #3487 a sale never lowers `StockLot.remainingQty`, so the lot figure can no longer prove
 * "the goods were used" — a re-apply on top of sold goods would invent stock. The ledger is the figure
 * that still moves: ANY decreasing `StockMovement` for the product after the live receipt (a sale, a
 * write-off, a negative adjustment, a supplier return) means the received quantity is no longer
 * intact. Deliberately judged on the movement, not on the current stock: a sale followed by a
 * return-to-stock puts the counter back at the received quantity and the goods are still not "as
 * received".
 *
 * Not counted: the compensating rows of another PO re-apply or a vendor-bill un-receive (negative
 * PURCHASE/ADJUSTMENT that carry the reversal note) — those undo a receipt, they do not consume
 * goods. This is the ONE helper; the PO re-apply guard calls it and nothing re-derives the rule.
 */
export interface LiveReceipt {
  productId: string;
  effectiveAt: Date;
  createdAt: Date;
}

/**
 * The ledger rows that count as "goods used" for `productId` after `r`: decreasing, later than the
 * receipt on either clock, and not a reversal pair. ONE predicate for the PO guard and the bill
 * reversal note.
 */
function usedSinceWhere(productId: string, r: LiveReceipt): Prisma.StockMovementWhereInput {
  return {
    productId,
    quantity: { lt: 0 },
    // after the receipt on EITHER clock: a backdated sale still ran after the goods arrived
    OR: [{ effectiveAt: { gt: r.effectiveAt } }, { createdAt: { gt: r.createdAt } }],
    NOT: {
      type: { in: [MovementType.PURCHASE, MovementType.ADJUSTMENT] },
      OR: [
        { notes: { startsWith: PO_REVERSAL_NOTE } },
        { notes: { startsWith: BILL_REVERTED_NOTE } },
        { notes: { startsWith: BILL_VOID_SHORTFALL_NOTE } },
      ],
    },
  };
}

/** The earliest receipt per product: a document can hold several, the first anchors the question. */
function earliestPerProduct(receipts: readonly LiveReceipt[]): Map<string, LiveReceipt> {
  const anchor = new Map<string, LiveReceipt>();
  for (const r of receipts) {
    const have = anchor.get(r.productId);
    if (!have || r.effectiveAt < have.effectiveAt) anchor.set(r.productId, r);
  }
  return anchor;
}

/** Product ids that have a decreasing movement after their earliest live receipt. */
export async function productsUsedSinceReceipt(
  tx: Prisma.TransactionClient,
  receipts: readonly LiveReceipt[],
): Promise<string[]> {
  const used: string[] = [];
  for (const [productId, r] of earliestPerProduct(receipts)) {
    const hit = await tx.stockMovement.findFirst({
      where: usedSinceWhere(productId, r),
      select: { id: true },
    });
    if (hit) used.push(productId);
  }
  return used;
}

/**
 * How many units left each product after its earliest live receipt (Σ |decreasing movements|, same
 * predicate as {@link productsUsedSinceReceipt}). The bill reversal's "already consumed" note reads
 * this: a sale no longer lowers the lot, so the lot can no longer say.
 */
export async function qtyUsedSinceReceipt(
  tx: Prisma.TransactionClient,
  receipts: readonly LiveReceipt[],
): Promise<Map<string, Prisma.Decimal>> {
  const out = new Map<string, Prisma.Decimal>();
  for (const [productId, r] of earliestPerProduct(receipts)) {
    const rows = await tx.stockMovement.findMany({
      where: usedSinceWhere(productId, r),
      select: { quantity: true, type: true, notes: true },
    });
    let total = new Prisma.Decimal(0);
    for (const m of rows ?? []) {
      const q = new Prisma.Decimal(m.quantity);
      if (q.gte(0)) continue;
      // belt and braces for the pair exclusion the where already states
      const pairRow =
        (m.type === MovementType.PURCHASE || m.type === MovementType.ADJUSTMENT) &&
        typeof m.notes === "string" &&
        (m.notes.startsWith(PO_REVERSAL_NOTE) ||
          m.notes.startsWith(BILL_REVERTED_NOTE) ||
          m.notes.startsWith(BILL_VOID_SHORTFALL_NOTE));
      if (pairRow) continue;
      total = total.add(q.abs());
    }
    out.set(productId, total);
  }
  return out;
}

/** The 409 both re-apply refusals throw (a partly consumed lot, or goods used per the ledger). */
export function poGoodsUsedConflict(
  poNumber: string,
  lotIds: string[],
  productIds: string[] = [],
): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.PO_LOT_PARTIALLY_CONSUMED,
    message:
      `Part of what was received on ${poNumber} has already been used (sold, written off or ` +
      "adjusted away), so its inventory can't be re-applied — that would invent stock. " +
      "Save the edit as document-only (keep stock as is), or record a return.",
    lotIds,
    ...(productIds.length > 0 ? { productIds } : {}),
  });
}
