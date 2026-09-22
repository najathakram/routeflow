/**
 * Shared "how much of this product has already been returned" accounting for
 * returns.service.ts — split out of `create()` so the same numbers are used by
 * both the STANDARD post-delivery flow and the (PR-1c/1d) INLINE capture flow.
 *
 * CORRECTED (live production regression, B661/B671 fix round 2): `OrderItem.qty` is stored in
 * the LINE's OWN unit — boxes for a box-unaware boxed line, not pieces; `regulatedUnitBasis`
 * (`packages/pricing`) is what expands it to pieces, at write time, for the regulated ledger
 * only. `ReturnItem.qty` for a STANDARD return mirrors `OrderItem.qty` (same unit, via the
 * identity conversion `standardReturnPieces` below), so it is ALSO the line's own unit, not
 * pieces — the prior version of this comment claimed the opposite, and
 * `RegulatedLedgerService.reverseReturnEntries` trusted it, comparing a box count against a
 * piece-denominated remaining balance and reversing ~8% of a fully-returned box-unaware sale.
 * `reverseReturnEntries`'s own `returnedUnit: "LINE_UNIT"` (the standard caller) vs `"PIECES"`
 * (the INLINE caller, whose `ReturnItem.qty` genuinely IS pieces — see
 * `inline-returns.service.ts`'s `capture()`) is the fix; this file's own comparisons
 * (over-return refusal, prior-returned sums) never needed pieces and are unaffected — this is a
 * documentation correction only, no logic in this file changes. `standardReturnPieces` remains
 * an identity function — the seam (B4/m-6) is unused today, kept for a future box/piece-aware
 * DTO.
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
 * Sold qty for (order, product) = the SUM of the product's non-CANCELLED lines on that
 * order, in EACH line's own unit (boxes for a box-unaware line — see the corrected file
 * header; the function/param names here predate that correction and are kept as-is to avoid
 * an unrelated rename). Fixes the B4/m-6 undercount: the pre-fix code picked a single
 * `.find()`-matched line, so a product split across two lines on the same
 * order (a re-added line, a post-edit split) undercounted what was actually
 * sold.
 */
export function soldPiecesForProduct(order: OrderForPieces, productId: string): number {
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
 * Converts a STANDARD return DTO's `qty` onto the axis of `firstNonCancelledLine` — the
 * LINE's own unit, not pieces (corrected; see the file header) — and returns a converter
 * back to that same unit for refusal messages; an identity conversion today for that reason.
 * `create()` and the shared prior-returned reader both call this so a future non-identity
 * conversion only has to change here.
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
