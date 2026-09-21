/**
 * Shared "how much of this product has already been returned" accounting for
 * returns.service.ts — split out of `create()` so the same numbers are used by
 * both the STANDARD post-delivery flow and the (PR-1c/1d) INLINE capture flow.
 *
 * UNITS (corrected under B665; this header used to say "always PIECES", which is false). `OrderItem.qty`
 * is counted in the LINE'S OWN UNIT: pieces for a box-split or ordinary line, but BOXES for a box-unaware
 * boxed line (a standing-order / buyer bare-qty line of a boxed product is stored `boxes: null,
 * unitsPerBox: null`, qty = boxes). `ReturnItem.qty` of a STANDARD return is what the operator typed,
 * capped by that same raw line qty, so it is in the line's own unit too (every creator: web returns page,
 * mobile operator return, driver undelivered return). So `soldQtyForProduct` and the STANDARD returned qty
 * are consistent with each other, which is why `create()`'s cap works, but NEITHER is a piece count for a
 * box-unaware line. INLINE items (`returnedPiecesByProduct` below adds them in) ARE true pieces, so a
 * product that was returned by both paths on a box-unaware line sums two units: a known limit of that
 * reader, not fixed here. Stock and the regulated ledger convert through `common/line-pack-factors.ts`
 * (`legacyLinePieces`), never by assuming this axis is pieces.
 *
 * `standardReturnPieces` stays a named seam (B4/m-6) so a future box/piece-aware DTO can convert without
 * `create()`'s comparison or its refusal-message text changing shape; today it is an identity function on
 * the line's own axis.
 */

export interface OrderLineForPieces {
  productId: string | null;
  qty: unknown;
  status?: string | null;
  position?: number | null;
}

export interface OrderForPieces {
  lineItems: OrderLineForPieces[];
}

/**
 * Sold qty for (order, product) = the SUM of the product's non-CANCELLED
 * lines on that order, in the LINE'S OWN UNIT (see the file header: boxes for
 * a box-unaware boxed line, NOT pieces). Fixes the B4/m-6 undercount: the pre-fix code picked a single
 * `.find()`-matched line, so a product split across two lines on the same
 * order (a re-added line, a post-edit split) undercounted what was actually
 * sold.
 */
export function soldQtyForProduct(order: OrderForPieces, productId: string): number {
  return (order.lineItems ?? [])
    .filter((li) => li.productId === productId && li.status !== "CANCELLED")
    .reduce((sum, li) => sum + Number(li.qty), 0);
}

/**
 * The product's first non-CANCELLED line in `position` order (nulls last) —
 * the same line `create()`'s original `lineItems.find` selected, kept as the
 * axis a future box/piece-aware conversion would key off. Unused by the
 * identity conversion today; exported so a caller can still name "the line
 * this return is against" the same way `create()` always has.
 */
export function firstNonCancelledLine(
  order: OrderForPieces,
  productId: string,
): OrderLineForPieces | undefined {
  const candidates = (order.lineItems ?? []).filter(
    (li) => li.productId === productId && li.status !== "CANCELLED",
  );
  return [...candidates].sort((a, b) => {
    const ap = a.position ?? Number.MAX_SAFE_INTEGER;
    const bp = b.position ?? Number.MAX_SAFE_INTEGER;
    return ap - bp;
  })[0];
}

/**
 * Converts a STANDARD return DTO's `qty` to pieces off the axis of
 * `firstNonCancelledLine`, and returns a converter back to that line's own
 * unit for refusal messages — see the file header for why this is an
 * identity conversion today. `create()` and the shared prior-returned reader
 * both call this so a future non-identity conversion only has to change here.
 */
export function standardReturnPieces(
  order: OrderForPieces,
  productId: string,
  qty: number,
): { pieces: number; toLineUnit: (pieces: number) => number } {
  // Keeps `firstNonCancelledLine` a live dependency of this seam (unused by the
  // identity conversion itself) so a future axis-aware conversion has it ready.
  void firstNonCancelledLine(order, productId);
  return { pieces: qty, toLineUnit: (pieces: number) => pieces };
}

/** Minimal shape `returnedPiecesByProduct` needs from a transaction/prisma client. */
export interface ReturnsPiecesTx {
  return: {
    findMany: (args: any) => Promise<any[]>;
  };
  returnItem: {
    findMany: (args: any) => Promise<any[]>;
  };
}

/**
 * Prior-returned pieces per product for a SOURCE order — B4's shared reader,
 * keyed (orderId, productId). Sums BOTH:
 *  - STANDARD `Return` rows scoped by `Return.orderId` (today's only kind), and
 *  - INLINE `ReturnItem` rows scoped by `ReturnItem.sourceOrderId` (PR-1c/1d;
 *    always empty until an INLINE return exists — this function is wired to
 *    include them from day one so the over-return guard never has to be
 *    revisited when INLINE capture ships).
 * Excludes REJECTED/CANCELLED on both sides, matching `create()`'s existing
 * STANDARD-only exclusion.
 */
export async function returnedPiecesByProduct(
  tx: ReturnsPiecesTx,
  orderId: string,
): Promise<Record<string, number>> {
  const [standardReturns, inlineItems] = await Promise.all([
    tx.return.findMany({
      where: { orderId, kind: "STANDARD", status: { notIn: ["REJECTED", "CANCELLED"] } },
      include: { items: { select: { productId: true, qty: true } } },
    }),
    tx.returnItem.findMany({
      where: {
        sourceOrderId: orderId,
        return: { kind: "INLINE", status: { notIn: ["REJECTED", "CANCELLED"] } },
      },
      select: { productId: true, qty: true },
    }),
  ]);

  const result: Record<string, number> = {};
  for (const ret of standardReturns) {
    for (const item of ret.items ?? []) {
      result[item.productId] = (result[item.productId] ?? 0) + Number(item.qty);
    }
  }
  for (const item of inlineItems) {
    if (!item.productId) continue;
    result[item.productId] = (result[item.productId] ?? 0) + Number(item.qty);
  }
  return result;
}
