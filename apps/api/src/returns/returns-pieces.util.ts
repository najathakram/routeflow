/**
 * Shared "how much of this product has already been returned" accounting for
 * returns.service.ts — split out of `create()` so the same numbers are used by
 * both the STANDARD post-delivery flow and the (PR-1c/1d) INLINE capture flow.
 *
 * CORRECTED (live production regression, B661/B671 fix round 2): `OrderItem.qty` is stored in
 * the LINE's OWN unit — boxes for a box-unaware boxed line, not pieces; `regulatedUnitBasis`
 * (`packages/pricing`) is what expands it to pieces, at write time, for the regulated ledger
 * only. `ReturnItem.qty` for a STANDARD return mirrors `OrderItem.qty` (same unit; `standardReturnPieces`
 * below converts a typed qty to pieces only for the CAP, never on disk), so it is ALSO the line's own unit, not
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
import {
  needsPackResolution,
  resolvePackFactors,
  type PackLine,
} from "../common/line-pack-factors";
import { piecesPerQtyOf } from "../credit-notes/line-credit-headroom";
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
 * the same line `create()`'s original `lineItems.find` selected, kept so a caller
 * can still name "the line this return is against" the same way `create()` always
 * has. Not used by the pack conversion, which resolves per PRODUCT (`productPackBasis`).
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
  loadInvoiceItems: (lineIds: string[]) => Promise<Map<string, any[]>> = liveInvoiceItemsByLine(tx),
): Promise<Map<string, ProductPackBasis>> {
  const live = (lines ?? []).filter((li) => li.productId && li.status !== "CANCELLED");
  const packs = await resolvePackFactors({
    orderId,
    lines: live as PackLine[],
    loadInvoiceItems,
  });
  const out = new Map<string, ProductPackBasis>();
  for (const li of live) {
    if (!out.has(li.productId as string))
      out.set(li.productId as string, productPackBasis(live, packs, li.productId as string));
  }
  return out;
}

/**
 * The pack basis of every product on each of SEVERAL orders (the returns list prices a page of rows), keyed by order id, with ONE
 * invoice-item read for the whole page instead of one per row: only the ambiguous lines (a pack with no split) need the
 * evidence, so a page with none costs no query at all.
 */
export async function standardPackBasesForOrders(
  tx: any,
  orders: Array<{ id?: string | null; lineItems?: OrderLineForPieces[] | null }>,
): Promise<Map<string, Map<string, ProductPackBasis>>> {
  const out = new Map<string, Map<string, ProductPackBasis>>();
  const withLines = orders.filter((o) => o?.id && (o.lineItems?.length ?? 0) > 0);
  const ambiguousIds = new Set<string>();
  for (const o of withLines)
    for (const li of o.lineItems as OrderLineForPieces[])
      if (li.id && li.productId && li.status !== "CANCELLED" && needsPackResolution(li as PackLine))
        ambiguousIds.add(li.id);
  const evidence =
    ambiguousIds.size > 0
      ? await liveInvoiceItemsByLine(tx)([...ambiguousIds])
      : new Map<string, any[]>();
  const fromCache = async (ids: string[]) =>
    new Map(ids.filter((id) => evidence.has(id)).map((id) => [id, evidence.get(id) as any[]]));
  for (const o of withLines) {
    const id = o.id as string;
    if (out.has(id)) continue;
    out.set(id, await standardPackBases(tx, id, o.lineItems as OrderLineForPieces[], fromCache));
  }
  return out;
}

/** A product's factor, or the reason it has none. Never factor 1 for unknown (the B650 bug). */
export function packFactorOrReason(
  bases: Map<string, ProductPackBasis>,
  productId: string,
): { factor: number } | { unknown: true; reason: string } {
  const basis = bases.get(productId);
  if (!basis || "noLines" in basis)
    return {
      unknown: true,
      reason: `Quantity basis unknown for product ${productId}: no live order line`,
    };
  if ("unknown" in basis)
    return {
      unknown: true,
      reason: `Quantity basis unknown for product ${productId}: ${basis.reason}`,
    };
  if ("mixed" in basis)
    return {
      unknown: true,
      reason: `Product ${productId} is on order lines with different pack sizes (${basis.factors.join(" and ")} pieces per unit), so a returned quantity cannot be attributed to one; return it inline, per line.`,
    };
  return { factor: basis.factor };
}

/**
 * The factor (pieces per line unit) for a product, or a 409. Mixed factors cannot attribute a
 * product-level typed qty to a line: the operator returns it inline, per line. The messages carry a
 * product id and factors only.
 */
export function requirePackFactor(bases: Map<string, ProductPackBasis>, productId: string): number {
  const res = packFactorOrReason(bases, productId);
  if ("unknown" in res) throw new ConflictException(res.reason);
  return res.factor;
}

/**
 * SA-161: how a STANDARD return's cap runs for a product. `pieces` when the factor is known;
 * `lineUnit` when EVERY live line is unresolvable (the legacy box-unaware shape): typed and sold share
 * the line's own unit, so the cap is exact with no pack (master's arithmetic) — no pack is guessed or
 * written. Anything else that cannot be classified (mixed factors, no line, an unresolvable line beside a
 * resolvable one) is a 409.
 */
export function capBasis(
  bases: Map<string, ProductPackBasis>,
  productId: string,
): { mode: "pieces"; factor: number } | { mode: "lineUnit" } {
  const basis = bases.get(productId);
  if (basis && "unknown" in basis && basis.singleUnit) return { mode: "lineUnit" };
  return { mode: "pieces", factor: requirePackFactor(bases, productId) };
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
  return {
    pieces: qty * factor,
    toLineUnit: (pieces: number) => Math.round((pieces / factor) * 100) / 100,
  };
}

/**
 * B969 (SA-628p): the ONE axis a STANDARD return is priced on, shared by the refund preview (`priceReturn`), the single-invoice
 * itemiser and the mint, so they can never disagree. `pieces: true` => the returned qty is converted with `standardReturnPieces`
 * (the order line's pack factor) and each BILLED invoice item with `piecesPerQtyOf` (a box-split item's qty is already pieces,
 * a selling-unit item's is boxes x upb): pieces on BOTH sides, never a third axis. `pieces: false` is the legacy shape whose pack
 * no evidence proves (every live line unresolvable, `create()`'s `lineUnit` cap): typed and billed qty share the line's unit, so
 * the price runs in raw qty exactly as before. A mixed basis, an unknown basis beside a resolvable line, or billed items with
 * different factors on a product with no live line has no single axis: `unresolved`. So does the legacy line-unit shape
 * once a billed item carries a split (it counts pieces), the items' factors differ, or the order has 2+ creditable invoices. The mint refuses an
 * unresolved product 409 RETURN_MIXED_UNIT_PRODUCT; the preview reports 0 with a reason.
 */
export type ReturnPricingAxis = { pieces: boolean; returned: number } | { unresolved: true };

export function returnPricingAxis(
  bases: Map<string, ProductPackBasis>,
  productId: string,
  qty: number,
  billedItems: ReadonlyArray<Parameters<typeof piecesPerQtyOf>[0] & { qty?: unknown }>,
  /** 2+ creditable invoices: the order pool counts in pieces and refuses an unknown basis (`poolPieces`), so the price must too. */
  opts: { pooled?: boolean } = {},
): ReturnPricingAxis {
  const basis = bases.get(productId);
  if (basis && "factor" in basis)
    return { pieces: true, returned: standardReturnPieces(bases, productId, qty).pieces };
  if (basis && "unknown" in basis && basis.singleUnit) {
    // The legacy line-unit price needs a billed side that is ALSO in the line's unit. A billed item carrying a boxes/pieces
    // split counts PIECES (provably not the line's boxes), and items with different pieces-per-qty cannot be summed: both
    // are ambiguous (a line billed across several items parks, it is never read from the split), so refused, never priced raw.
    if (opts.pooled) return { unresolved: true };
    const live = billedItems.filter((it) => Number(it.qty) > 0);
    const hasSplit = live.some((it) => it.boxes != null || it.pieces != null);
    if (hasSplit || new Set(live.map(piecesPerQtyOf)).size > 1) return { unresolved: true };
    return { pieces: false, returned: qty };
  }
  if (basis && ("unknown" in basis || "mixed" in basis)) return { unresolved: true };
  // No live order line for the product (the pre-line / fixture shape): the billed items' own single factor, as the pool does.
  const factors = new Set(billedItems.filter((it) => Number(it.qty) > 0).map(piecesPerQtyOf));
  if (factors.size > 1) return { unresolved: true };
  return { pieces: true, returned: qty * ([...factors][0] ?? 1) };
}

/** Prior-returned for one product: pieces, or why it cannot be classified (SA-159/SA-161). */
export type PriorReturned =
  | { pieces: number }
  | {
      unknown: true;
      reason: string;
      /** SA-161: prior STANDARD qty in the line's own unit — the legacy-shape cap nets in these. */
      lineUnits: number;
      /** Prior INLINE qty in pieces: cannot be netted against line units without a factor. */
      inlinePieces: number;
    };

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
): Promise<Record<string, PriorReturned>> {
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

  // B671: a STANDARD item's qty is in its line's own unit and an INLINE item's is in pieces — put them
  // on ONE axis (pieces) before adding. The pack basis is only loaded when a STANDARD item exists.
  // SA-159: the result is PER PRODUCT and never throws — a product whose STANDARD prior cannot be
  // classified is `unknown` (sticky), so a return or quote of a DIFFERENT product on the same order
  // still proceeds; only the unclassifiable product's own consumer refuses.
  const result: Record<string, PriorReturned> = {};
  const add = (productId: string, pieces: number) => {
    const cur = result[productId];
    if (cur && "unknown" in cur) cur.inlinePieces += pieces;
    else result[productId] = { pieces: (cur?.pieces ?? 0) + pieces };
  };
  const addUnknown = (productId: string, reason: string, lineUnits: number) => {
    const cur = result[productId];
    if (cur && "unknown" in cur) cur.lineUnits += lineUnits;
    else result[productId] = { unknown: true, reason, lineUnits, inlinePieces: cur?.pieces ?? 0 };
  };
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
    const f = packFactorOrReason(basisMap!, item.productId);
    if ("unknown" in f) addUnknown(item.productId, f.reason, Number(item.qty));
    else add(item.productId, Number(item.qty) * f.factor);
  }
  for (const item of inlineItems) {
    if (!item.productId) continue;
    add(item.productId, Number(item.qty));
  }
  return result;
}
