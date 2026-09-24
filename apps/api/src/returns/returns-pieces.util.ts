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
 * documentation correction only, no logic in this file changes.
 *
 * SA-158 (B650/B754/B671): the over-return CAP and the prior-returned sum are computed in PIECES.
 * `standardReturnPieces` converts a typed qty (line unit) with the product's pack factor, resolved by
 * the same `resolvePackFactors` the restock resolver uses (`productPackBasis`); an unknown pack, or a
 * product on lines with different factors, is REFUSED with a 409 — never booked as factor 1.
 * `ReturnItem.qty` on disk, and every money figure, stay in the line's own unit.
 *
 * STOCK (B665, this branch): the restock path converts through `common/line-pack-factors.ts` (`legacyLinePieces`) and never assumes this axis is pieces; an
 * unknown pack books no movement and PARKS. The regulated ledger's own axis is handled by
 * `reverseReturnEntries`'s `returnedUnit` above, not here.
 */

import { ConflictException } from "@nestjs/common";
import { resolvePackFactors, type PackLine } from "../common/line-pack-factors";
import {
  liveInvoiceItemsByLine,
  productPackBasis,
  type ProductPackBasis,
} from "./returns-restock-pieces";

/** The order-line columns `resolvePackFactors` reads — shared by every loader of this order's lines. */
export const PACK_LINE_SELECT = {
  id: true,
  productId: true,
  qty: true,
  status: true,
  position: true,
  boxes: true,
  pieces: true,
  unitsPerBox: true,
  unitLabel: true,
  product: { select: { unitsPerBox: true } },
} as const;

export interface OrderLineForPieces {
  /** Feeds `resolvePackFactors`; absent on a fixture line that carries no pack evidence. */
  id?: string;
  productId: string | null;
  qty: unknown;
  status?: string | null;
  position?: number | null;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  unitLabel?: string | null;
  product?: { unitsPerBox?: number | null } | null;
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
 * The pack basis of every product on the order's non-cancelled lines: a line's factor comes from
 * `resolvePackFactors` (own split, unit-aware label, else its one linked live InvoiceItem), and a
 * product's factor from `productPackBasis` (all lines must agree). Only the ambiguous lines touch the
 * DB (`tx.invoiceItem`), so a split or unit-aware order costs no extra query.
 */
export async function standardPackBases(
  tx: any,
  orderId: string,
  lines: OrderLineForPieces[],
): Promise<Map<string, ProductPackBasis>> {
  const live = (lines ?? []).filter((li) => li.productId && li.status !== "CANCELLED");
  const packs = await resolvePackFactors({
    orderId,
    lines: live as PackLine[],
    loadInvoiceItems: liveInvoiceItemsByLine(tx),
  });
  const out = new Map<string, ProductPackBasis>();
  for (const li of live) {
    if (!out.has(li.productId as string))
      out.set(li.productId as string, productPackBasis(live, packs, li.productId as string));
  }
  return out;
}

/**
 * The factor (pieces per line unit) for a product, or a 409. Unknown is never factor 1 (that
 * fallthrough is the B650 bug), and mixed factors cannot attribute a product-level typed qty to a line:
 * the operator returns it inline, per line. The messages carry a product id and factors only.
 */
export function requirePackFactor(bases: Map<string, ProductPackBasis>, productId: string): number {
  const basis = bases.get(productId);
  if (!basis || "noLines" in basis)
    throw new ConflictException(
      `Quantity basis unknown for product ${productId}: no live order line`,
    );
  if ("unknown" in basis)
    throw new ConflictException(`Quantity basis unknown for product ${productId}: ${basis.reason}`);
  if ("mixed" in basis)
    throw new ConflictException(
      `Product ${productId} is on order lines with different pack sizes (${basis.factors.join(" and ")} pieces per unit), so a returned quantity cannot be attributed to one; return it inline, per line.`,
    );
  return basis.factor;
}

/**
 * Converts a STANDARD return DTO's typed `qty` (the LINE's own unit) to PIECES with the product's pack
 * factor, and returns a converter back to the line unit for refusal messages. Throws 409 for an unknown
 * or mixed basis (`requirePackFactor`). `create()` and the shared prior-returned reader both call this.
 */
export function standardReturnPieces(
  bases: Map<string, ProductPackBasis>,
  productId: string,
  qty: number,
): { pieces: number; toLineUnit: (pieces: number) => number } {
  const factor = requirePackFactor(bases, productId);
  return { pieces: qty * factor, toLineUnit: (pieces: number) => pieces / factor };
}

/** Minimal shape `returnedPiecesByProduct` needs from a transaction/prisma client. */
export interface ReturnsPiecesTx {
  orderItem?: {
    findMany: (args: any) => Promise<any[]>;
  };
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
  bases?: Map<string, ProductPackBasis>,
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
  // B671: a STANDARD item's qty is in its line's own unit and an INLINE item's is in pieces — put them
  // on ONE axis (pieces) before adding. The pack basis is only loaded when a STANDARD item exists.
  const standardItems = standardReturns.flatMap((ret) => ret.items ?? []);
  let basisMap = bases;
  if (standardItems.length && !basisMap) {
    const lines = await tx.orderItem!.findMany({
      where: { orderId, status: { not: "CANCELLED" } },
      select: PACK_LINE_SELECT,
    });
    basisMap = await standardPackBases(tx, orderId, lines);
  }
  for (const item of standardItems) {
    const { pieces } = standardReturnPieces(basisMap!, item.productId, Number(item.qty));
    result[item.productId] = (result[item.productId] ?? 0) + pieces;
  }
  for (const item of inlineItems) {
    if (!item.productId) continue;
    result[item.productId] = (result[item.productId] ?? 0) + Number(item.qty);
  }
  return result;
}
