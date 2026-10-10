import { ConflictException } from "@nestjs/common";
import { Prisma, UserRole } from "@prisma/client";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { recordSaleMovement } from "../inventory/sale-movement";
import { linePieceQty } from "./line-piece-qty";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { saleMarkers } from "./backorder-marker";
import {
  applyCarriedMarkers,
  applyEditMarkers,
  resetMarkers,
  writeSaleMarkers,
} from "./backorder-marker-writes";

/**
 * Stock bookkeeping for order writes — lifted verbatim out of `OrdersService` (B585 prefactor:
 * `orders.service.ts` is over its size ratchet, so the paths that must grow — credit and selling
 * restrictions — need room; behaviour identical). The class keeps two thin delegators with the same
 * names so no call site changes.
 */
export interface OrderStockDeps {
  logger: { warn(message: string): void };
  /** The ambient tenant id (`PrismaService.getTenantId()`), read where the class read it. */
  tenantId: string | null | undefined;
}

/**
 * B562 PR-2 (SA-136 §2): which order stock event a SALE movement records. `reference` on the row is
 * `ORDER:<orderId>`; `notes` is the event — CREATE | EDIT | CANCEL | UNCANCEL | PROMOTE | DEMOTE |
 * TEMPLATE:<templateId>; `performedById` is the acting user, or null for the standing-order cron.
 */
export interface OrderStockEvent {
  orderId: string;
  notes: string;
  performedById: string | null;
}

export const orderStockReference = (orderId: string) => `ORDER:${orderId}`;

/**
 * OOS PR2 (SA-714 R4): what a CUSTOMER is told when an order is refused for stock. Fixed copy, no
 * product names and NO stock numbers (the old message leaked "available: N" to a buyer). Staff and
 * drivers keep the numbers.
 */
export const CUSTOMER_INSUFFICIENT_STOCK_MESSAGE =
  "Some items aren't available in the amount you asked for. Lower the quantity or remove them, then try again.";

/** A stock helper's parameters after `deps`: what OrdersService's thin delegators take. */
export type StockArgs<F> = F extends (deps: OrderStockDeps, ...rest: infer R) => any ? R : never;

/**
 * B703 (SA-136b): the unit fields `linePieceQty` reads off a line. `currentStock` is counted in
 * PIECES, but a line's `qty` is in its own stored unit — pieces for a box-split or Units line, BOXES
 * for a box-unaware boxed line (boxes/pieces null, no unitLabel). Every stock path converts each line
 * to pieces ONCE, with the line's own `unitsPerBox` snapshot first and the product's live pack only
 * as the fallback, and feeds that one number to both the counter write and the SALE row.
 */
export interface StockLineUnits {
  boxes?: unknown;
  pieces?: unknown;
  unitsPerBox?: unknown;
  unitLabel?: unknown;
}
/**
 * `id` (a row that already exists: promotion, template cron, reopen) and `position` feed the SA-714
 * backorder marker only; they never touch the stock arithmetic.
 */
export type StockLine = StockLineUnits & {
  productId: string;
  qty: any;
  id?: string;
  position?: number | null;
};
/** Spread into an `orderItem.findMany` select so a settle caller hands over the unit fields. */
export const STOCK_LINE_UNIT_SELECT = {
  boxes: true,
  pieces: true,
  unitsPerBox: true,
  unitLabel: true,
} as const;
/** A sale line that already has a row (promotion, reopen): its units plus `id`/`position` for the marker. */
export const STOCK_SALE_LINE_SELECT = {
  id: true,
  productId: true,
  qty: true,
  deliveredQty: true,
  position: true,
  ...STOCK_LINE_UNIT_SELECT,
} as const;
/** The held-line select a cancel/demote settle reads: the line, its delivery, and its unit fields. */
export const STOCK_SETTLE_SELECT = {
  id: true,
  productId: true,
  qty: true,
  deliveredQty: true,
  status: true,
  ...STOCK_LINE_UNIT_SELECT,
} as const;

/** A box-unaware line with no own snapshot: only the product's live pack can size it. */
const needsLivePack = (li: StockLineUnits) =>
  li.unitsPerBox == null &&
  li.boxes == null &&
  li.pieces == null &&
  !(typeof li.unitLabel === "string" && li.unitLabel.trim() !== "");

/** `qty` (the line's own unit) in pieces, at the column's 3 decimals. */
const toPieces = (li: StockLineUnits, qty: unknown, livePack: unknown): number => {
  const pack = livePack != null ? Number(livePack) : undefined;
  return Math.round(linePieceQty({ ...li, boxes: li.boxes ?? null, qty }, pack) * 1000) / 1000;
};

/**
 * B283: the ONE stock-decrement code path for turning a set of order lines
 * into a real (non-draft) sale — locks the touched product rows FOR UPDATE,
 * blocks or warns on insufficient stock per `allowOversell`, then
 * applies ONE aggregated UPDATE. SA-606c: `allowOversell` is an already-resolved boolean — the
 * caller resolves any oversell policy BEFORE the transaction; nothing here ever reads a policy
 * (this section holds product row locks). Extracted out of create()'s non-draft
 * branch so changeStatus()'s DRAFT→PENDING promotion (the same "becomes a
 * real sale" moment) calls the IDENTICAL logic instead of a second
 * implementation — see REG-B283. Must be called from inside the caller's
 * transaction (the FOR UPDATE lock is only meaningful there).
 */
export async function decrementStockForSale(
  deps: OrderStockDeps,
  tx: any,
  stockLines: StockLine[],
  allowOversell: boolean,
  // `customerFacing`: the caller is a buyer, so a refusal carries the fixed copy and no numbers.
  event: OrderStockEvent & { customerFacing?: boolean },
): Promise<Map<StockLine, number>> {
  if (stockLines.length === 0) return new Map();
  const productIds = stockLines.map((li) => li.productId);
  // SELECT … FOR UPDATE acquires row-level locks in the current transaction.
  await tx.$executeRaw`
    SELECT id FROM "Product"
    WHERE id IN (${Prisma.join(productIds)})
    FOR UPDATE
  `;

  const lockedProducts = await tx.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, name: true, currentStock: true, unitsPerBox: true },
  });
  // B703 (SA-136b): each line in PIECES, once — the oversell check, the decrement and the SALE row
  // all read this one number (a 2-box line of a 12-pack is 24, never 2).
  const pieceLines = stockLines.map((li) => ({
    productId: li.productId,
    pieces: toPieces(
      li,
      li.qty,
      lockedProducts.find((lp: any) => lp.id === li.productId)?.unitsPerBox,
    ),
  }));

  const oosItems: string[] = [];
  for (const li of pieceLines) {
    const p = lockedProducts.find((lp: any) => lp.id === li.productId);
    if (p && Number(p.currentStock) < li.pieces) {
      oosItems.push(
        `${p.name ?? li.productId} (available: ${Number(p.currentStock)}, requested: ${li.pieces})`,
      );
    }
  }
  if (oosItems.length > 0) {
    if (allowOversell) {
      deps.logger.warn(`Operator-initiated order will go below stock: ${oosItems.join("; ")}`);
    } else {
      throw new ConflictException({
        code: API_ERROR_CODES.INSUFFICIENT_STOCK,
        message: event.customerFacing
          ? CUSTOMER_INSUFFICIENT_STOCK_MESSAGE
          : `Insufficient stock: ${oosItems.join("; ")}`,
      });
    }
  }

  // SA-714 R1 / SA-716: SET each line's backorder marker from THIS decrement's own result, from the
  // pre-decrement locked stock, in this tx. A line with a row is written now; a new line's value is
  // returned for the caller's nested create (informational only, nothing else reads it).
  const pending = await writeSaleMarkers(
    tx,
    saleMarkers({
      lines: stockLines,
      packByProduct: new Map(lockedProducts.map((lp: any) => [lp.id, lp.unitsPerBox])),
      availableByProduct: new Map(
        lockedProducts.map((lp: any) => [lp.id, Number(lp.currentStock)]),
      ),
      allowOversell,
    }),
  );

  // Decrement stock atomically while the lock is held. For operator-initiated
  // overselling, this lets currentStock go negative — the inventory page can
  // surface that and the operator can reconcile after restock.
  //
  // B116 (REG-B116): ONE aggregated, set-based UPDATE instead of a per-line
  // ORM call — a per-line write ordering is why multiple lines for the same
  // product used to touch it twice instead of once. Aggregate first:
  // `UPDATE … FROM (VALUES …)` applies at most one row per join key, so
  // summing qty per product BEFORE the statement is load-bearing.
  //
  // Raw SQL bypasses the tenant proxy that scoped the ORM call it replaces,
  // so the tenant predicate is re-stated explicitly here — a cross-tenant
  // productId must not be able to move another tenant's stock. Null
  // tenantId (SUPER_ADMIN context) keeps the unscoped behaviour the ORM
  // call had in that same context.
  const stockTenantId = deps.tenantId;
  const qtyByProduct = new Map<string, number>();
  for (const li of pieceLines) {
    const sum = (qtyByProduct.get(li.productId) ?? 0) + li.pieces;
    qtyByProduct.set(li.productId, Math.round(sum * 1000) / 1000);
  }
  const stockValues = Prisma.join(
    [...qtyByProduct.entries()].map(
      ([productId, qty]) => Prisma.sql`(${productId}::text, ${qty}::numeric)`,
    ),
  );
  // B562 PR-2: RETURNING the counter each row now holds — the SALE movement's `stockAfter` is read
  // from the write that moved it (SA-136 §2), never from the pre-lock read above. A product the
  // UPDATE did not match (cross-tenant id) returns no row and gets no movement, as it moved nothing.
  const moved: Array<{ id: string; currentStock: Prisma.Decimal }> = await tx.$queryRaw`
    UPDATE "Product" AS p
    SET "currentStock" = p."currentStock" - v.qty
    FROM (VALUES ${stockValues}) AS v(id, qty)
    WHERE p.id = v.id
      ${stockTenantId ? Prisma.sql`AND p."tenantId" = ${stockTenantId}` : Prisma.empty}
    RETURNING p.id, p."currentStock"
  `;
  for (const row of moved) {
    await recordSaleMovement(tx, {
      productId: row.id,
      quantity: -(qtyByProduct.get(row.id) ?? 0),
      stockAfter: row.currentStock,
      reference: orderStockReference(event.orderId),
      notes: event.notes,
      performedById: event.performedById,
    });
  }
  return pending;
}

/** SA-696: the coded 409 for ANY non-zero delta of an order with the carrier (a reduction wins a mix). */
function carrierLineSetRefusal(deltas: number[]): void {
  const reduces = deltas.some((d) => d < 0);
  throw new ConflictException(
    reduces
      ? {
          code: API_ERROR_CODES.ORDER_WITH_CARRIER_NO_REDUCE,
          message:
            "This order is already with the carrier. Record a return instead of reducing or removing lines.",
        }
      : {
          code: API_ERROR_CODES.ORDER_WITH_CARRIER_NO_ADD,
          message:
            "This order is already with the carrier. Create a new order for the extra items.",
        },
  );
}

/**
 * SA-696a: quantity deltas of the UNLISTED (no productId) lines of an order with the carrier. They never
 * touch stock, so the product maps above cannot see them. Identity is the stored line id: a final line
 * whose id is not held (or has no id) is NEW (+qty); a held line missing from the final set is REMOVED
 * (-qty); otherwise the qty change. Held lines with no id cannot be identified and are skipped.
 */
function unlistedLineDeltas(
  heldItems: Array<{ id?: string; productId: string | null; qty: any; status?: string }>,
  finalActiveItems: Array<{ id?: string; productId: string | null; qty: any }>,
): number[] {
  const round3 = (n: number) => Math.round(n * 1000) / 1000;
  const held = new Map<string, number>();
  for (const li of heldItems ?? []) {
    if (!li.productId && li.id && li.status !== "CANCELLED") held.set(li.id, Number(li.qty) || 0);
  }
  const deltas: number[] = [];
  for (const li of finalActiveItems) {
    if (li.productId) continue;
    const qty = Number(li.qty) || 0;
    if (li.id && held.has(li.id)) {
      deltas.push(round3(qty - held.get(li.id)!));
      held.delete(li.id);
    } else {
      deltas.push(round3(qty));
    }
  }
  for (const qty of held.values()) deltas.push(round3(-qty));
  return deltas.filter((d) => d !== 0);
}

/**
 * B1050 (SA-703): per-line booking. `deliveredQty` is never rewritten by an edit, so a line can sit
 * with qty < delivered; delivered goods are gone, so a line books `max(qty, delivered)`. The CALLER
 * says how the final lines relate to the held ones (`lineIdentity`):
 *  - "stable" (default; an in-place diff edit): a line is the SAME line when both sides carry the same
 *    NON-NULL id (undefined never matches). C_after = Σ matched max(q, d) + Σ removed held d + Σ new q;
 *    a struck delivered line stays booked (its d) and never nets against a new line of the product.
 *  - "recreated" (the deleteMany + re-create paths: operator replaceAll, CUSTOMER/DRIVER non-diff):
 *    ids are fresh, so nothing can match; C_after = max(Σ final q, Σ held d), the pooled behaviour.
 * C_before = Σ held max(q, d) either way; the counter moves by C_after − C_before. No credit cap.
 */
export type BookedParts = { fixed: number; perPack: number };
type BookedTerm = {
  bucket: "matched" | "unmatched";
  side: "before" | "after";
  a: BookedParts;
  b?: BookedParts;
};
type BookedLine = StockLineUnits & {
  id?: string;
  productId?: string | null;
  qty: any;
  deliveredQty?: any;
};
const ZERO_PARTS: BookedParts = { fixed: 0, perPack: 0 };
const plusParts = (x: BookedParts, y: BookedParts): BookedParts => ({
  fixed: x.fixed + y.fixed,
  perPack: x.perPack + y.perPack,
});
/** `qty` of one line as Parts: `fixed` pieces, or the raw `perPack` qty only the live pack can size. */
const partsOf = (li: StockLineUnits, qty: unknown): BookedParts =>
  needsLivePack(li)
    ? { fixed: 0, perPack: Number(qty) || 0 }
    : { fixed: toPieces(li, qty, undefined), perPack: 0 };
const piecesOfParts = (x: BookedParts, pack: unknown): number =>
  Math.round((x.fixed + toPieces({ boxes: null }, x.perPack, pack)) * 1000) / 1000;
const termPieces = (t: BookedTerm, pack: unknown): number => {
  const a = piecesOfParts(t.a, pack);
  return t.b ? Math.max(a, piecesOfParts(t.b, pack)) : a;
};

export type LineIdentity = "stable" | "recreated";

/** The booked-qty terms of ONE product's lines (held = non-cancelled pre-edit lines, final = post-edit). */
export function bookedTerms(
  held: BookedLine[],
  final: BookedLine[],
  identity: LineIdentity = "stable",
): BookedTerm[] {
  const finalById = new Map<string, BookedLine>();
  if (identity === "stable")
    for (const f of final) if (f.id != null && !finalById.has(f.id)) finalById.set(f.id, f);
  const matchedFinal = new Set<BookedLine>();
  const terms: BookedTerm[] = [];
  let heldD = ZERO_PARTS;
  let finalQ = ZERO_PARTS;
  for (const h of held) {
    const d = partsOf(h, h.deliveredQty ?? 0);
    const f = h.id != null ? finalById.get(h.id) : undefined;
    terms.push({ bucket: f ? "matched" : "unmatched", side: "before", a: partsOf(h, h.qty), b: d });
    if (f && !matchedFinal.has(f)) {
      matchedFinal.add(f);
      terms.push({ bucket: "matched", side: "after", a: partsOf(f, f.qty), b: d });
    } else if (identity === "stable") {
      terms.push({ bucket: "unmatched", side: "after", a: d }); // removed: delivered stays booked
    } else {
      heldD = plusParts(heldD, d);
    }
  }
  for (const f of final) {
    if (matchedFinal.has(f)) continue;
    if (identity === "stable")
      terms.push({ bucket: "unmatched", side: "after", a: partsOf(f, f.qty) });
    else finalQ = plusParts(finalQ, partsOf(f, f.qty));
  }
  if (identity === "recreated")
    terms.push({ bucket: "unmatched", side: "after", a: finalQ, b: heldD });
  return terms;
}

/**
 * Shared by the stock settle and the read-only reconciliation report: one product's booked pieces,
 * `matched` and `unmatched` kept as SEPARATE buckets (never folded), each with its before/after.
 */
export function bookedPieces(
  held: BookedLine[],
  final: BookedLine[],
  livePack?: unknown,
  identity: LineIdentity = "stable",
) {
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const out = { matched: { before: 0, after: 0 }, unmatched: { before: 0, after: 0 } };
  for (const t of bookedTerms(held, final, identity))
    out[t.bucket][t.side] += termPieces(t, livePack);
  return {
    matched: { before: r3(out.matched.before), after: r3(out.matched.after) },
    unmatched: { before: r3(out.unmatched.before), after: r3(out.unmatched.after) },
    before: r3(out.matched.before + out.unmatched.before),
    after: r3(out.matched.after + out.unmatched.after),
  };
}

/**
 * The effective delta as Parts with NO pack read (the short circuit before any lock), or null when a
 * max cannot be decided without the live pack — that product is then locked and read.
 */
function effectiveDeltaParts(terms: BookedTerm[]): BookedParts | null {
  let delta = ZERO_PARTS;
  for (const t of terms) {
    let v = t.a;
    if (t.b) {
      if (t.a.fixed >= t.b.fixed && t.a.perPack >= t.b.perPack) v = t.a;
      else if (t.b.fixed >= t.a.fixed && t.b.perPack >= t.a.perPack) v = t.b;
      else return null;
    }
    const sign = t.side === "after" ? 1 : -1;
    delta = plusParts(delta, { fixed: sign * v.fixed, perPack: sign * v.perPack });
  }
  return delta;
}

/**
 * P5-08b + WP1 stock settle — validates the delta between the order's
 * pre-edit line set and the edited (post-edit) active line set, THEN
 * applies it to `Product.currentStock`.
 *
 * Lifecycle (why delta, not absolute): create() already decremented
 * Product.currentStock for every non-draft line under a row lock (RF-017,
 * create() ~line 1850-1902), so the order's existing lines are already "out
 * of" currentStock. NOTHING ELSE decrements for delivery — completeStop
 * writes no stock and InventoryService.recordSale has no caller — so
 * `currentStock` is settled at order time and re-settled here on edit, and
 * nowhere else. An edit therefore only needs to settle the
 * CHANGE against what the order already holds:
 *   - a product whose requested qty EXCEEDS its held qty needs the increase
 *     validated against currentStock (same guard as before), then that
 *     increase decremented;
 *   - a product whose booked qty FALLS (line reduced, removed, or zeroed)
 *     returns the difference to currentStock. Booked qty is per line
 *     `max(qty, deliveredQty)` (B1050 / SA-703, see `bookedTerms`): delivered
 *     goods are gone and never come back via an edit, and an edit below
 *     delivered neither credits nor, on the way back up, decrements them a
 *     second time. There is no pooled per-product cap. This is new; the
 *     pre-refactor version only validated increases, it never wrote
 *     anything.
 * Held/requested are compared over the UNION of product ids on both sides
 * (not just `requested`'s keys) so a product that disappears from the
 * edited set entirely (line removed) still gets its stock credited back.
 * A product with a ZERO delta (unchanged line) never enters the delta map
 * at all — no lock, no read, no write for it (see the DELTA_MAP short
 * circuit below), which is also why a same-qty edit never re-queries stock.
 *
 * Role semantics mirror create(): CUSTOMER/DRIVER hard-block (409
 * INSUFFICIENT_STOCK) with NO write on a violation; everyone else
 * (operator/admin/undefined = internal caller) may knowingly oversell —
 * warn-only log, and then (unlike the old validate-only guard) the write
 * still proceeds, matching create()'s oversell-writes-anyway posture.
 * B703 (SA-136b): every quantity — held, delivered, requested — is converted to
 * PIECES per line (`linePieceQty`, the line's own pack snapshot first, the
 * product's live pack as the fallback) before anything is summed, so the delta,
 * the booked qty, the counter write and the SALE row are all in the unit
 * `currentStock` counts. (It used to compare each line's stored unit — boxes for
 * a box-unaware line — against a piece counter.)
 *
 * `SELECT ... FOR UPDATE` locks the touched product rows FIRST, before
 * reading currentStock — mirroring create()'s lock (:1863-1867). The old
 * validate-only assert read unlocked because it reserved nothing; now that
 * this method WRITES currentStock, the lock is load-bearing (closes the
 * same concurrent-oversell race create() closes). B562 PR-2: each write now
 * appends its SALE StockMovement (SA-136 §1/§2), like create().
 *
 * Applies to DELIVERED/OUT_FOR_DELIVERY orders too: a qty increase on an
 * already-dispatched order means more goods physically went out the door,
 * symmetric with create() decrementing at order time.
 *
 * Skips ENTIRELY — no validation, no write, no query — when
 * `order.status === "DRAFT"`: creation never decremented stock for a draft,
 * so an edit of one must not either.
 *
 * Unknown/missing product rows and non-numeric quantities fail OPEN (skip)
 * for VALIDATION only — same posture as create()'s `if (p && ...)`; the
 * write still applies for every non-zero delta regardless (mirrors
 * create()'s unconditional decrement loop).
 *
 * `heldItems` is the pre-edit line set and MUST be read INSIDE the caller's
 * transaction, after that transaction has locked the order row
 * (`SELECT id FROM "Order" … FOR UPDATE`) and BEFORE it writes any
 * orderItem. Reading it from a pre-transaction `order.lineItems` snapshot
 * made the delta stale under a concurrent edit of the same order (web PATCH
 * racing an at-door approve), which settles a wrong-MAGNITUDE stock write —
 * far worse than a lost update, because the error persists in inventory.
 */
export async function settleStockForEdit(
  deps: OrderStockDeps,
  db: any,
  order: { id: string; status: string },
  heldItems: Array<
    StockLineUnits & {
      id?: string;
      productId: string | null;
      qty: any;
      deliveredQty?: any;
      status?: string;
    }
  >,
  finalActiveItems: Array<StockLineUnits & { id?: string; productId: string | null; qty: any }>,
  user?: JwtPayload,
  /** B562 PR-2: the event the SALE rows record (default EDIT); the acting user wins over `performedById`. */
  event: { notes: string; performedById?: string | null } = { notes: "EDIT" },
  /**
   * WS9: when provided, `allowOversell` REPLACES the role test below (a resolved boolean — never a
   * policy read here, SA-606c). Absent: CUSTOMER/DRIVER refuse, everyone else may oversell.
   */
  opts?: {
    allowOversell?: boolean;
    blockCredits?: boolean;
    lineIdentity?: LineIdentity;
    /** SA-716: "set" for a re-decrement (reopen); the default edit ADJUSTS the backorder marker. */
    markerMode?: "adjust" | "set";
    /** SA-716 M2: held markers captured before a recreate-mode create-merge fold (product + pack group). */
    markerCarry?: ReadonlyMap<string, number>;
  },
): Promise<void> {
  if (order.status === "DRAFT") return;

  // SA-696a: an order with the carrier has a fixed line set, unlisted lines included (they carry no
  // product, so the stock deltas below cannot see them). Folded into the SAME refusal as the product
  // deltas, so a reduction anywhere wins a mix. Checked before any lock or write.
  const unlistedDeltas = opts?.blockCredits ? unlistedLineDeltas(heldItems, finalActiveItems) : [];

  // Qty the order already holds per product (pre-edit, non-cancelled lines), as RAW parts (what the
  // carrier refusal reads); the counter itself moves by the BOOKED delta (`bookedTerms`, B1050): each
  // line books max(qty, deliveredQty). Delivered goods are physically gone: an edit that shrinks or
  // drops a delivered line must NOT put them back on the shelf. This mirrors the at-door precedent, where
  // a CHANGE_QTY/REMOVE_ITEM request against a line with deliveredQty > 0 is refused outright
  // (LINE_ALREADY_DELIVERED, ~:4205) — the operator edit path allows the edit but credits back only
  // what the line's delivered floor frees.
  //
  // B703 (SA-136b): all three sums end up in PIECES. Per product each is `fixed` (lines sized without
  // the live pack: box-split, Units, or their own pack snapshot) plus `perPack` (the raw
  // qty of box-unaware lines, which only the product's LIVE pack can size — the pack create() sized
  // them by). A product whose `fixed` and `perPack` are both unchanged has a zero delta at any pack,
  // so it is dropped before any lock or read (DELTA_MAP short circuit below); the rest read the live
  // pack in the same locked row read as `currentStock`.
  type Parts = { fixed: number; perPack: number };
  const add = (
    m: Map<string, Parts>,
    li: StockLineUnits & { productId: string | null },
    qty: unknown,
  ) => {
    const cur = m.get(li.productId as string) ?? { fixed: 0, perPack: 0 };
    if (needsLivePack(li)) cur.perPack += Number(qty) || 0;
    else cur.fixed += toPieces(li, qty, undefined);
    m.set(li.productId as string, cur);
  };
  const heldParts = new Map<string, Parts>();
  const heldLines = new Map<string, BookedLine[]>();
  const finalLines = new Map<string, BookedLine[]>();
  const group = (m: Map<string, BookedLine[]>, li: BookedLine) =>
    m.set(li.productId as string, [...(m.get(li.productId as string) ?? []), li]);
  for (const li of heldItems ?? []) {
    if (li.productId && li.status !== "CANCELLED") {
      add(heldParts, li, li.qty);
      group(heldLines, li);
    }
  }
  // Qty the edit requests per product (post-edit active line set).
  const requestedParts = new Map<string, Parts>();
  for (const li of finalActiveItems) {
    if (!li.productId) continue;
    add(requestedParts, li, li.qty);
    group(finalLines, li);
  }

  // Delta per product over the UNION of both sides — a product present only
  // in `held` (its line was removed/zeroed in the edit) still gets an entry
  // here (delta = 0 − held < 0) so its stock is returned. Zero-delta
  // products (untouched lines) are dropped, so they never trigger a lock, a
  // stock read, or a write (DELTA_MAP short circuit).
  // Qty is Decimal(10,3): subtracting two float-converted Decimals leaves
  // binary residue (36 − 12.1 = 23.900000000000002), which `!== 0` reads as
  // a real delta and would write a phantom 1e-15 stock adjustment. Round to
  // the column's 3 decimals BEFORE the zero check, and write the ROUNDED
  // value.
  const round3 = (n: number) => Math.round(n * 1000) / 1000;
  const zero: Parts = { fixed: 0, perPack: 0 };
  const productIds = [...new Set([...heldParts.keys(), ...requestedParts.keys()])];
  // RAW touched: requested − held changed (what the carrier refusal reads). EFFECTIVE touched
  // (B1050): C_after − C_before changed (what the counter moves by). The effective short circuit
  // runs only AFTER the carrier refusal's inputs are settled (SA-703 M5): a with-carrier order locks
  // the union so the refusal is computed from the RAW deltas, never from the effective ones.
  const rawTouched = productIds.filter((id) => {
    const h = heldParts.get(id) ?? zero;
    const r = requestedParts.get(id) ?? zero;
    return round3(r.fixed - h.fixed) !== 0 || round3(r.perPack - h.perPack) !== 0;
  });
  const terms = new Map(
    productIds.map((id) => [
      id,
      bookedTerms(heldLines.get(id) ?? [], finalLines.get(id) ?? [], opts?.lineIdentity),
    ]),
  );
  const effTouched = productIds.filter((id) => {
    const d = effectiveDeltaParts(terms.get(id)!);
    return d == null || round3(d.fixed) !== 0 || round3(d.perPack) !== 0;
  });
  const touched = opts?.blockCredits ? [...new Set([...rawTouched, ...effTouched])] : effTouched;
  // SA-716 M2: the create-merge fold recreated every line; its carried markers must survive a zero delta.
  const carryOnly = () =>
    opts?.markerCarry
      ? applyCarriedMarkers(db, {
          carry: opts.markerCarry,
          allowOversell: false,
          products: [],
          deltas: new Map(),
          finalLines,
          piecesOf: toPieces,
        })
      : undefined;
  if (touched.length === 0) {
    await carryOnly();
    if (unlistedDeltas.length > 0) carrierLineSetRefusal(unlistedDeltas);
    return;
  }

  // RF-017 parity: lock the touched product rows BEFORE reading
  // currentStock, mirroring create()'s lock (:1863-1867).
  await db.$executeRaw`
    SELECT id FROM "Product"
    WHERE id IN (${Prisma.join(touched)})
    FOR UPDATE
  `;
  const products = await db.product.findMany({
    where: { id: { in: touched } },
    select: { id: true, name: true, currentStock: true, unitsPerBox: true },
  });
  const pieces = (m: Map<string, Parts>, id: string) => {
    const { fixed, perPack } = m.get(id) ?? zero;
    const pack = products.find((p: any) => p.id === id)?.unitsPerBox;
    return round3(fixed + toPieces({ boxes: null }, perPack, pack));
  };
  const requested = new Map<string, number>();
  const rawDeltas: number[] = [];
  const deltas = new Map<string, number>();
  for (const id of touched) {
    requested.set(id, pieces(requestedParts, id));
    const raw = round3(requested.get(id)! - pieces(heldParts, id));
    if (raw !== 0) rawDeltas.push(raw);
    const pack = products.find((p: any) => p.id === id)?.unitsPerBox;
    const delta = round3(
      terms
        .get(id)!
        .reduce((sum, t) => sum + (t.side === "after" ? 1 : -1) * termPieces(t, pack), 0),
    );
    if (delta !== 0) deltas.set(id, delta);
  }
  // B1082 (B2) + SA-696: a carrier order WITH the carrier has a fixed line set. A removal / decrease would
  // put its stock back on the shelf while the parcel is still out (returns go through the return flow);
  // an add / increase would grow a shipment that already left (extra items are a new order). Computed
  // from the RAW deltas + the unlisted lines', BEFORE the effective delta can short-circuit (SA-703 M5).
  if (opts?.blockCredits && rawDeltas.length + unlistedDeltas.length > 0)
    carrierLineSetRefusal([...rawDeltas, ...unlistedDeltas]);
  if (deltas.size === 0) return carryOnly();

  const mayOversell =
    opts?.allowOversell ?? (user?.role !== UserRole.CUSTOMER && user?.role !== UserRole.DRIVER);
  const increases = [...deltas.entries()]
    .filter(([, delta]) => delta > 0)
    .map(([productId, delta]) => ({
      productId,
      requested: requested.get(productId) ?? 0,
      delta,
    }));

  if (increases.length > 0) {
    const violations: Array<{
      productId: string;
      name: string;
      available: number;
      requested: number;
      delta: number;
    }> = [];
    for (const inc of increases) {
      const p = products.find((lp: any) => lp.id === inc.productId);
      if (p && Number(p.currentStock) < inc.delta) {
        violations.push({
          productId: inc.productId,
          name: p.name,
          available: Number(p.currentStock),
          requested: inc.requested,
          delta: inc.delta,
        });
      }
    }
    if (violations.length > 0) {
      if (mayOversell) {
        // Operators/admins may oversell — matches create()'s warn-only path.
        // Unlike the old validate-only guard, this does NOT return: the
        // write below still applies so the oversell lands in currentStock,
        // exactly like create()'s oversell write.
        deps.logger.warn(
          `Operator edit of order ${order.id} will go below stock: ` +
            violations
              .map((v) => `${v.name} (available: ${v.available}, requested increase: ${v.delta})`)
              .join("; "),
        );
      } else {
        const first = violations[0];
        // A buyer gets the fixed copy and no numbers; staff and drivers keep them.
        if (user?.role === UserRole.CUSTOMER) {
          throw new ConflictException({
            code: API_ERROR_CODES.INSUFFICIENT_STOCK,
            message: CUSTOMER_INSUFFICIENT_STOCK_MESSAGE,
          });
        }
        throw new ConflictException({
          code: API_ERROR_CODES.INSUFFICIENT_STOCK,
          message:
            `Not enough stock for ${first.name} ` +
            `(available: ${first.available}, requested: ${first.requested}).`,
          productId: first.productId,
          available: first.available,
          requested: first.requested,
        });
      }
    }
  }

  // SA-714 R1 / SA-716: the backorder marker, from the stock this edit saw (locked, pre-write). A
  // recreate-mode edit has no matching line ids, so it writes none (B1167: the marker is lost).
  if (opts?.lineIdentity === "recreated") {
    if (opts.markerCarry)
      await applyCarriedMarkers(db, {
        carry: opts.markerCarry,
        allowOversell: mayOversell,
        products,
        deltas,
        finalLines,
        piecesOf: toPieces,
      });
  } else
    await applyEditMarkers(db, {
      mode: opts?.markerMode ?? "adjust",
      allowOversell: mayOversell,
      products,
      deltas,
      heldLines,
      finalLines,
      piecesOf: toPieces,
    });

  // Apply the BOOKED delta (B1050): a rise decrements currentStock by it; a fall increments back what
  // the per-line `max(qty, deliveredQty)` floor frees. Delivered goods never come back through an edit —
  // the at-door path makes the same call by refusing the change outright (LINE_ALREADY_DELIVERED,
  // ~:4205); crediting a delivered line's full qty would invent inventory that physically left. No
  // pooled cap: the floor is already inside the delta. B562 PR-2: every write appends its SALE
  // movement (−increase / +credit), `stockAfter` from the update's own row.
  const saleRow = (productId: string, quantity: number, updated: { currentStock: any }) =>
    recordSaleMovement(db, {
      productId,
      quantity,
      stockAfter: updated.currentStock,
      reference: orderStockReference(order.id),
      notes: event.notes,
      performedById: user?.sub ?? event.performedById ?? null,
    });
  for (const [productId, delta] of deltas) {
    if (delta > 0) {
      const updated = await db.product.update({
        where: { id: productId },
        data: { currentStock: { decrement: delta } },
      });
      await saleRow(productId, -delta, updated);
      continue;
    }
    // B1050: the delta already nets the delivered floor per line (max(q, d)), so a decrease credits
    // exactly what it frees — no pooled per-product cap.
    const credit = -delta;
    const updated = await db.product.update({
      where: { id: productId },
      data: { currentStock: { increment: credit } },
    });
    await saleRow(productId, credit, updated);
  }
}

/**
 * B64 (REG-B64): reopenOrder's re-decrement, lifted out of `OrdersService` (size ratchet; behaviour
 * identical). `cancelledLines` are the item-CANCELLED lines read INSIDE the caller's tx before they flip
 * back to PENDING — exactly the set an F07 cancel credited stock back for. The delivered portion is
 * modelled as already held, so the settle delta is qty − deliveredQty per product (what the cancel
 * credited back). Staff-only path → no user → warn-only oversell, matching create()'s staff behaviour.
 */
export async function restoreStockForReopen(
  deps: OrderStockDeps,
  tx: any,
  orderId: string,
  cancelledLines: Array<
    StockLineUnits & { id?: string; productId: string | null; qty: any; deliveredQty?: any }
  >,
): Promise<void> {
  if (cancelledLines.length === 0) return;
  // B1050: held and requested are the SAME lines, matched by id (index when the caller read none), so each books max(qty, delivered) against the delivered floor it already holds.
  const held = cancelledLines.map((li, i) => {
    const delivered = Number(li.deliveredQty ?? 0);
    const id = li.id ?? `reopen:${i}`;
    return { ...li, id, qty: delivered, deliveredQty: delivered, status: "PENDING" };
  });
  const requested = cancelledLines.map((li, i) => ({
    ...li,
    id: li.id ?? `reopen:${i}`,
    qty: Number(li.qty),
  }));
  // SA-716: a reopen SETS every re-taken line, including a product whose stock delta is 0.
  await resetMarkers(
    tx,
    cancelledLines.flatMap((li) => (li.id ? [li.id] : [])),
  );
  await settleStockForEdit(
    deps,
    tx,
    { id: orderId, status: "PENDING" },
    held,
    requested,
    undefined,
    { notes: "UNCANCEL" },
    { markerMode: "set" }, // SA-716: a reopen is a fresh sale of the re-taken lines — its own value
  );
}
