import { ConflictException } from "@nestjs/common";
import { Prisma, UserRole } from "@prisma/client";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { recordSaleMovement } from "../inventory/sale-movement";
import { linePieceQty } from "./line-piece-qty";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * Stock bookkeeping for order writes — lifted verbatim out of `OrdersService` (B585 prefactor:
 * `orders.service.ts` is over its size ratchet, so the paths that must grow — credit and selling
 * restrictions — need room; behaviour identical). The class keeps two thin delegators with the same
 * names so no call site changes.
 */
export interface OrderStockDeps {
  logger: { warn(message: string): void; error?(message: string): void };
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
 * SA-606k/n: what a locked stock write returns. `backorderByProduct` is the overshoot THIS write
 * created per product (pieces), read from the write's own result under the row lock — never from an
 * earlier read. Every product the write touched is present (0 when it stayed in stock).
 */
export interface StockWriteResult {
  backorderByProduct: Map<string, number>;
  /**
   * The order this write was made on, set by a caller that returns a DIFFERENT order than the one it
   * created (the template Reorder returns the sweep's order): the buyer controller re-reads THIS id to
   * decide which order holds the request's lines (B975, SA-631d).
   */
  orderId?: string;
}

/**
 * The overshoot a write created: of `requested` pieces taken, how many pushed the counter below zero.
 * `newStock` is what the row held AFTER the write. Right when stock was already negative (all of
 * `requested` is backordered) and when the order is fully covered (0).
 */
export const backorderFromLockedStock = (requested: number, newStock: number): number =>
  Math.round(Math.min(requested, Math.max(0, -newStock)) * 1000) / 1000;

const STOCK_WRITE = Symbol("stockWrite");
/**
 * SA-606m (4) / SA-606o Q-C: hand the locked write's result from `OrdersService.create` /
 * `updateOrderItems` to the caller that maps it onto a response. A typed, NON-enumerable property:
 * it is invisible to JSON and to a spread copy, so it can never reach the wire by accident (a staff
 * response must not carry a backorder figure), and it is absent whenever nothing was written.
 */
export function withStockWrite<T>(order: T, write: StockWriteResult | undefined): T {
  if (order && write) {
    Object.defineProperty(order, STOCK_WRITE, {
      value: write,
      enumerable: false,
      configurable: true,
    });
  }
  return order;
}
export const stockWriteOf = (order: unknown): StockWriteResult | undefined =>
  (order as { [STOCK_WRITE]?: StockWriteResult } | null | undefined)?.[STOCK_WRITE];

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
export type StockLine = StockLineUnits & { productId: string; qty: any };
/** Spread into an `orderItem.findMany` select so a settle caller hands over the unit fields. */
export const STOCK_LINE_UNIT_SELECT = {
  boxes: true,
  pieces: true,
  unitsPerBox: true,
  unitLabel: true,
} as const;
/** The held-line select a cancel/demote settle reads: the line, its delivery, and its unit fields. */
export const STOCK_SETTLE_SELECT = {
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
export const toPieces = (li: StockLineUnits, qty: unknown, livePack: unknown): number => {
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
  event: OrderStockEvent,
): Promise<StockWriteResult> {
  if (stockLines.length === 0) return { backorderByProduct: new Map() };
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

  // SA-606k: a line that cannot be sized is refused BEFORE any stock write, whatever the policy.
  // Non-finite pieces come from product DATA (a boxed line whose pack is missing), so they are a
  // coded 409 the tenant can fix; a NEGATIVE line is our own contract violation (the DTO forbids it)
  // and must page, so it is a RangeError (500) with an error log — never a 4xx.
  stockLines.forEach((li, i) => {
    const name = lockedProducts.find((lp: any) => lp.id === li.productId)?.name ?? li.productId;
    const pieces = pieceLines[i].pieces;
    if (Number(li.qty) < 0 || pieces < 0) {
      const msg = `decrementStockForSale: negative line for ${name} (${li.productId}) on order ${event.orderId}: ${pieces} pieces`;
      deps.logger.error?.(msg);
      throw new RangeError(msg);
    }
    if (!Number.isFinite(Number(li.qty)) || !Number.isFinite(pieces)) {
      throw new ConflictException({
        code: "INVENTORY_QUANTITY_INVALID",
        message: `Cannot size the ${name} line: its quantity is not a valid number.`,
        productId: li.productId,
        name,
      });
    }
  });

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
      throw new ConflictException(`Insufficient stock: ${oosItems.join("; ")}`);
    }
  }

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
  // SA-606k: every touched product is present (0 = stayed in stock); a product the UPDATE did not
  // match (cross-tenant id) moved nothing and stays 0.
  const backorderByProduct = new Map<string, number>([...qtyByProduct.keys()].map((id) => [id, 0]));
  for (const row of moved) {
    backorderByProduct.set(
      row.id,
      backorderFromLockedStock(qtyByProduct.get(row.id) ?? 0, Number(row.currentStock)),
    );
    await recordSaleMovement(tx, {
      productId: row.id,
      quantity: -(qtyByProduct.get(row.id) ?? 0),
      stockAfter: row.currentStock,
      reference: orderStockReference(event.orderId),
      notes: event.notes,
      performedById: event.performedById,
    });
  }
  return { backorderByProduct };
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
 *   - a product whose requested qty is LESS than held (line reduced,
 *     removed, or zeroed) returns the difference to currentStock, CLAMPED
 *     to the undelivered remainder (`held − deliveredQty`) — delivered
 *     goods are gone and never come back via an edit. This is new; the
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
 * the undelivered cap, the counter write and the SALE row are all in the unit
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
    StockLineUnits & { productId: string | null; qty: any; deliveredQty?: any; status?: string }
  >,
  finalActiveItems: Array<StockLineUnits & { productId: string | null; qty: any }>,
  user?: JwtPayload,
  /** B562 PR-2: the event the SALE rows record (default EDIT); the acting user wins over `performedById`. */
  event: { notes: string; performedById?: string | null } = { notes: "EDIT" },
  /**
   * WS9: when provided, `allowOversell` REPLACES the role test below (a resolved boolean — never a
   * policy read here, SA-606c). Absent: CUSTOMER/DRIVER refuse, everyone else may oversell.
   */
  opts?: { allowOversell?: boolean },
): Promise<StockWriteResult> {
  if (order.status === "DRAFT") return { backorderByProduct: new Map() };

  // Qty the order already holds per product (pre-edit, non-cancelled lines),
  // plus — over the SAME line set — how much of it has already gone out the
  // door. Delivered goods are physically gone: an edit that shrinks or drops
  // a delivered line must NOT put them back on the shelf. This mirrors the
  // at-door precedent, where a CHANGE_QTY/REMOVE_ITEM request against a line
  // with deliveredQty > 0 is refused outright (LINE_ALREADY_DELIVERED,
  // ~:4205) — the operator edit path allows the edit but credits back only
  // the UNDELIVERED remainder.
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
  const deliveredParts = new Map<string, Parts>();
  for (const li of heldItems ?? []) {
    if (li.productId && li.status !== "CANCELLED") {
      add(heldParts, li, li.qty);
      add(deliveredParts, li, li.deliveredQty ?? 0);
    }
  }
  // Qty the edit requests per product (post-edit active line set).
  const requestedParts = new Map<string, Parts>();
  for (const li of finalActiveItems) if (li.productId) add(requestedParts, li, li.qty);

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
  const touched = [...new Set([...heldParts.keys(), ...requestedParts.keys()])].filter((id) => {
    const h = heldParts.get(id) ?? zero;
    const r = requestedParts.get(id) ?? zero;
    return round3(r.fixed - h.fixed) !== 0 || round3(r.perPack - h.perPack) !== 0;
  });
  if (touched.length === 0) return { backorderByProduct: new Map() };

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
  const held = new Map<string, number>();
  const deliveredHeld = new Map<string, number>();
  const requested = new Map<string, number>();
  const deltas = new Map<string, number>();
  for (const id of touched) {
    held.set(id, pieces(heldParts, id));
    deliveredHeld.set(id, pieces(deliveredParts, id));
    requested.set(id, pieces(requestedParts, id));
    const delta = round3(requested.get(id)! - held.get(id)!);
    if (delta !== 0) deltas.set(id, delta);
  }
  if (deltas.size === 0) return { backorderByProduct: new Map() };

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
      const mayOversell =
        opts?.allowOversell ?? (user?.role !== UserRole.CUSTOMER && user?.role !== UserRole.DRIVER);
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

  // Apply: an increase decrements currentStock by the delta; a
  // decrease/removal increments back only the UNDELIVERED portion of what
  // the order held. Delivered goods never come back through an edit — the
  // at-door path makes the same call by refusing the change outright
  // (LINE_ALREADY_DELIVERED, ~:4205); crediting a delivered line's full qty
  // would invent inventory that physically left the warehouse. Cap =
  // max(0, held − deliveredHeld); a fully-delivered line's cap is 0, so it
  // is skipped entirely (no write at all). B562 PR-2: every write appends its
  // SALE movement (−increase / +credit), `stockAfter` from the update's own row.
  const saleRow = (productId: string, quantity: number, updated: { currentStock: any }) =>
    recordSaleMovement(db, {
      productId,
      quantity,
      stockAfter: updated.currentStock,
      reference: orderStockReference(order.id),
      notes: event.notes,
      performedById: user?.sub ?? event.performedById ?? null,
    });
  // SA-606e C9: the edit's backorder is the shortfall of THIS write's per-product DELTA, from the
  // counter the write itself left — never a whole-order figure recomputed from current stock.
  const backorderByProduct = new Map<string, number>();
  for (const [productId, delta] of deltas) {
    backorderByProduct.set(productId, 0);
    if (delta > 0) {
      const updated = await db.product.update({
        where: { id: productId },
        data: { currentStock: { decrement: delta } },
      });
      backorderByProduct.set(
        productId,
        backorderFromLockedStock(delta, Number(updated.currentStock)),
      );
      await saleRow(productId, -delta, updated);
      continue;
    }
    // Held and delivered are both pieces (above), so the cap is too.
    const undelivered = Math.max(
      0,
      round3((held.get(productId) ?? 0) - (deliveredHeld.get(productId) ?? 0)),
    );
    const credit = Math.min(-delta, undelivered);
    if (credit <= 0) continue;
    const updated = await db.product.update({
      where: { id: productId },
      data: { currentStock: { increment: credit } },
    });
    await saleRow(productId, credit, updated);
  }
  return { backorderByProduct };
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
    StockLineUnits & { productId: string | null; qty: any; deliveredQty?: any }
  >,
): Promise<void> {
  if (cancelledLines.length === 0) return;
  const held = cancelledLines.map((li) => {
    const delivered = Number(li.deliveredQty ?? 0);
    return { ...li, qty: delivered, deliveredQty: delivered, status: "PENDING" };
  });
  const requested = cancelledLines.map((li) => ({ ...li, qty: Number(li.qty) }));
  await settleStockForEdit(
    deps,
    tx,
    { id: orderId, status: "PENDING" },
    held,
    requested,
    undefined,
    { notes: "UNCANCEL" },
  );
}
