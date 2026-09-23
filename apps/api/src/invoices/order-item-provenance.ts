import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * SA-093a ruling (2+3), round 6: an invoice item's `orderItemId`, when the client sends one,
 * MUST belong to the invoice's own order — refused otherwise. This is the root fix for findings
 * 2 and 3: `update()`'s rebuild previously dropped `orderItemId` on EVERY edit (even for a line
 * that already carried one), forcing the invoice→order back-sync into an ambiguous-product or
 * free-text fallback that could silently credit the wrong active line (finding 2) or drop a
 * line's `invoicedQty` to 0 and let it be re-billed (finding 3) — the same root cause both ways.
 * Positional or identity correlation is never attempted: an item's `orderItemId` is either a
 * real line of this order, or it is provenance-less and falls to the product-match fallback.
 *
 * Round 7, finding 3 (MED): the id-only check let a client pair a stale/spoofed `orderItemId`
 * with an unrelated `productId`, or point at a line already CANCELLED (which must never resolve
 * to a live match). Now also refuses a CANCELLED line outright, and a `productId` mismatch when
 * the client sends BOTH fields for the same item (a client that omits `productId` is unaffected
 * — the order line's own stored product is what matters, never a client-asserted one).
 */
export async function assertOrderItemIdsBelongToOrder(
  db: Prisma.TransactionClient,
  orderId: string | null,
  items: Array<{ orderItemId?: string; productId?: string | null }>,
): Promise<void> {
  const requested = [
    ...new Set(items.map((i) => i.orderItemId).filter((id): id is string => !!id)),
  ];
  if (requested.length === 0) return;
  if (!orderId) {
    throw new BadRequestException("orderItemId was sent, but this invoice has no linked order.");
  }
  const rows = await db.orderItem.findMany({
    where: { id: { in: requested }, orderId },
    select: { id: true, productId: true, status: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const item of items) {
    if (!item.orderItemId) continue;
    const row = byId.get(item.orderItemId);
    if (!row) {
      throw new BadRequestException(
        `orderItemId ${item.orderItemId} is not on this invoice's order`,
      );
    }
    if (row.status === "CANCELLED") {
      throw new BadRequestException(`orderItemId ${item.orderItemId} is a CANCELLED order line`);
    }
    if (item.productId && row.productId && item.productId !== row.productId) {
      throw new BadRequestException(
        `orderItemId ${item.orderItemId}'s product does not match the order line's product`,
      );
    }
  }
}

/** SA-093a round 6, ruling 2+3: "never silently" -- both fallback-skip warns in one call. */
export function logSkippedMatches(
  logger: { warn(msg: string): void },
  orderId: string,
  freeformSkipped: string[],
  coverage: { fullyCovered: boolean; skippedAmbiguousLineIds?: string[] },
): void {
  if (freeformSkipped.length > 0) {
    logger.warn(
      `recomputeOrderFromInvoices: order ${orderId} skipped free-text invoice item(s) with no orderItemId/productId: ${freeformSkipped.join(", ")}`,
    );
  }
  const ambiguousSkipped = coverage.fullyCovered ? [] : (coverage.skippedAmbiguousLineIds ?? []);
  if (ambiguousSkipped.length > 0) {
    logger.warn(
      `recomputeOrderFromInvoices: order ${orderId} skipped ambiguous-product order line(s): ${ambiguousSkipped.join(", ")}`,
    );
  }
}
