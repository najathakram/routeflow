/**
 * SA-763r R6 (B692): a DELIVERED order books what left. One helper, `stampDeliveredInFull(tx, orderId, mode)`,
 * for every write of DELIVERED that carries no per-line delivery data of its own, and for the edits of a
 * DELIVERED order.
 *
 * Why: `OrderItem.deliveredQty` is the signal stock (order-stock.ts, B1050) and cancel-impact (B56) read to
 * know the goods are gone. A manual DELIVERED, a counter sale and a pickup hand-over wrote only the status,
 * so the order read "nothing delivered": a later qty cut restocked goods the customer holds, and a cancel
 * was offered and voided the invoices.
 *
 * EVIDENCE-SAFE. It touches ONLY lines with no qualifying DeliveryMutation row (`hasDeliveryEvidence`, the
 * ONE evidence predicate, shared with the counter-sale void's inverse `clearUnevidencedDelivered`). A line
 * with rows keeps its route evidence (the column there is a RECOMPUTE from the rows, routes.service.ts,
 * never an overwrite from here). An order with a `routeRunStopId` (a legacy route delivery) is never
 * touched. A value is never lowered (qty < delivered is legal, B1050). No evidence row is ever written or
 * rewritten from here.
 *
 * It runs in the CALLER's transaction: the status and the stamp commit together. The route-stop writers
 * (routes.service.ts completeStop / completeWithPayment) already recompute from rows and are allow-listed:
 * they do not call this.
 *
 * Demotion (DELIVERED -> CONFIRMED / PARTIALLY_DELIVERED) clears only `deliveredAt`: the stamp stays, the
 * goods left, so cancel-impact keeps refusing a cancel (use a Return).
 */
import { ConflictException } from "@nestjs/common";
import { OrderStatus, type Prisma } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { deliveredBasisByLine, type DeliveredBasis } from "../invoices/delivered-basis-by-line";
import type { PrismaService } from "../prisma/prisma.service";

const EPS = 0.0005;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const UNLISTED = "\u0000unlisted"; // the key of catalog-free lines in the per-product carry

/**
 * ONE definition of "this line has qualifying DeliveryMutation evidence": the line owns at least one qualifying row of
 * the delivery-evidence reader (invoices/delivered-basis-by-line.ts: a delivery-evidence type with a non-null
 * quantityDelivered, a REFUSED row included). `basis` comes from `deliveredBasisByLine(tx, orderId)`.
 */
export const hasDeliveryEvidence = (basis: DeliveredBasis, lineId: string): boolean =>
  basis.byLineId.has(lineId);

/** A pre-edit line, as `updateOrderItems` reads it under the Order lock. */
export type HeldLine = {
  id: string;
  productId: string | null;
  qty: unknown;
  deliveredQty?: unknown;
  status?: string;
};

/**
 * What a replace-all ("recreated") edit must remember from BEFORE its deleteMany. Only an order with NO evidence
 * row gets here (`captureRecreatedCarry` refuses the rest), so every held line is a no-evidence line.
 */
export type RecreatedCarry = {
  held: Array<{ id: string; key: string; deliveredQty: number }>;
};

const keyOf = (productId: string | null | undefined) => productId ?? UNLISTED;

/**
 * INVARIANT: on a no-evidence line of a DELIVERED, non-route order, `deliveredQty` is the booked floor (the units
 * that physically left); stock already books max(qty, deliveredQty).
 * Modes (SA-763r M2):
 *  - "entry" = any write of DELIVERED: `deliveredQty := max(deliveredQty, qty)` on no-evidence lines.
 *  - "edit" = a stable-id (diff / merge) edit of a DELIVERED order: on every no-evidence line
 *    `deliveredQty := max(deliveredQty, oldQty, newQty)`, `held` being the pre-edit lines. A cut never lowers it;
 *    a raise lifts it to the new qty (items added after hand-over count as handed over); the first edit of a
 *    legacy line (d 0, never stamped) normalises it to its old qty first.
 *  - "recreated" = a replace-all edit of a DELIVERED order WITHOUT evidence rows (new row ids): each recreated
 *    row first carries the delivered quantity its product had before the edit (the per-product sum of the
 *    deleted rows' deliveredQty, captured by `captureRecreatedCarry` BEFORE the delete), then the entry rule.
 * "edit" and "recreated" act only while the order (read under the caller's lock) is DELIVERED.
 *
 * Returns how many lines were raised.
 */
export async function stampDeliveredInFull(
  tx: Prisma.TransactionClient,
  orderId: string,
  mode: "entry",
): Promise<number>;
export async function stampDeliveredInFull(
  tx: Prisma.TransactionClient,
  orderId: string,
  mode: "edit",
  held: HeldLine[],
): Promise<number>;
export async function stampDeliveredInFull(
  tx: Prisma.TransactionClient,
  orderId: string,
  mode: "recreated",
  carry: RecreatedCarry,
): Promise<number>;
export async function stampDeliveredInFull(
  tx: Prisma.TransactionClient,
  orderId: string,
  mode: "entry" | "edit" | "recreated",
  arg?: HeldLine[] | RecreatedCarry,
): Promise<number> {
  const head = await tx.order.findFirst({
    where: { id: orderId },
    select: { status: true, routeRunStopId: true },
  });
  if (!head || head.routeRunStopId) return 0; // gone, or a legacy route delivery: its columns stay
  if (mode !== "entry" && head.status !== OrderStatus.DELIVERED) return 0;
  const lines = await tx.orderItem.findMany({
    where: { orderId },
    select: { id: true, productId: true, qty: true, deliveredQty: true, status: true },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });
  const basis = await deliveredBasisByLine(tx, orderId); // built on hasDeliveryEvidence
  const active = lines.filter(
    (li) => li.status !== "CANCELLED" && !hasDeliveryEvidence(basis, li.id),
  );
  const targets = new Map<string, number>();
  if (mode === "entry") {
    for (const li of active) targets.set(li.id, Math.max(Number(li.deliveredQty), Number(li.qty)));
  } else if (mode === "edit") {
    const heldQty = new Map((arg as HeldLine[]).map((h) => [h.id, Number(h.qty)]));
    for (const li of active) {
      targets.set(
        li.id,
        Math.max(Number(li.deliveredQty), heldQty.get(li.id) ?? 0, Number(li.qty)),
      );
    }
  } else {
    recreatedTargets(arg as RecreatedCarry, lines, active, targets);
  }
  let raised = 0;
  for (const li of active) {
    const target = targets.get(li.id);
    if (target === undefined || target <= Number(li.deliveredQty) + EPS) continue; // never lowers
    await tx.orderItem.update({ where: { id: li.id }, data: { deliveredQty: target } });
    raised += 1;
  }
  return raised;
}

/** The recreated rows' targets: carry the product's pre-edit delivered sum, then the entry rule. */
function recreatedTargets(
  carry: RecreatedCarry,
  all: Array<{ id: string }>,
  active: Array<{ id: string; productId: string | null; qty: unknown; deliveredQty: unknown }>,
  targets: Map<string, number>,
): void {
  const heldIds = new Set(carry.held.map((h) => h.id));
  const surviving = new Set(all.map((l) => l.id).filter((id) => heldIds.has(id)));
  const carried = new Map<string, number>();
  for (const h of carry.held) {
    if (!surviving.has(h.id)) carried.set(h.key, (carried.get(h.key) ?? 0) + h.deliveredQty);
  }
  const fresh = active.filter((li) => !heldIds.has(li.id)); // a surviving row is not recreated
  const lastOfKey = new Map<string, string>();
  for (const li of fresh) lastOfKey.set(keyOf(li.productId), li.id);
  for (const li of fresh) {
    const key = keyOf(li.productId);
    const left = carried.get(key) ?? 0;
    // Spread the carried sum over the product's rows in order, each up to its qty; the last takes the rest.
    const take = lastOfKey.get(key) === li.id ? left : Math.min(left, Number(li.qty));
    carried.set(key, r3(left - take));
    targets.set(li.id, Math.max(Number(li.deliveredQty), r3(take), Number(li.qty)));
  }
}

/**
 * Called BEFORE a replace-all edit deletes the order's lines (inside the edit tx, after the Order lock).
 * A DELIVERED order with ANY qualifying DeliveryMutation row is REFUSED (409 ORDER_EDIT_NEEDS_LINE_IDS, before
 * any line is touched): the delete would orphan the evidence rows (their orderItemId is set null), and the
 * stable-id edit is the one model that keeps them attached. Otherwise it remembers each held line's delivered
 * quantity for the carry. Null when the order is not DELIVERED, or rode a route stop: nothing to carry.
 */
export async function captureRecreatedCarry(
  tx: Prisma.TransactionClient,
  orderId: string,
  held: HeldLine[],
): Promise<RecreatedCarry | null> {
  const head = await tx.order.findFirst({
    where: { id: orderId },
    select: { status: true, routeRunStopId: true },
  });
  if (!head || head.status !== OrderStatus.DELIVERED) return null;
  const basis = await deliveredBasisByLine(tx, orderId);
  if (basis.hasMutations) {
    throw new ConflictException({
      code: API_ERROR_CODES.ORDER_EDIT_NEEDS_LINE_IDS,
      message:
        "This order was delivered with delivery records. Edit its lines one by one (keep each line's id) instead of replacing all of them.",
    });
  }
  if (head.routeRunStopId) return null;
  return {
    held: held.map((h) => ({
      id: h.id,
      key: keyOf(h.productId),
      // no evidence on this order (refused above): the units that left are the booked floor max(d, qty); a
      // CANCELLED line was already returned to the shelf (never booked), so it keeps its stored value
      deliveredQty:
        h.status === "CANCELLED"
          ? Number(h.deliveredQty ?? 0)
          : Math.max(Number(h.deliveredQty ?? 0), Number(h.qty)),
    })),
  };
}

/**
 * The pre-edit lines AS THE STOCK SETTLE MUST SEE THEM (an input to `settleStockForEdit` only; no row is written
 * here). On a DELIVERED, non-route order, a held line with no delivery record has `deliveredQty = max(d, qty)`:
 * the units that left. A legacy line (never stamped, d 0) cut from 12 to 10 would otherwise book `max(10, 0)` and
 * put 2 back on the shelf, which the stamp then undoes (d := 12): a later void would credit those 2 again. The
 * same booked-floor pattern as the void's `bookedFloor`. Any other order: `held` unchanged (one head read).
 */
export async function heldAtBookedFloor<T extends HeldLine>(
  tx: Prisma.TransactionClient,
  orderId: string,
  held: T[],
): Promise<T[]> {
  const head = await tx.order.findFirst({
    where: { id: orderId },
    select: { status: true, routeRunStopId: true },
  });
  if (!head || head.status !== OrderStatus.DELIVERED || head.routeRunStopId) return held;
  const basis = await deliveredBasisByLine(tx, orderId);
  return held.map((h) =>
    hasDeliveryEvidence(basis, h.id) || h.status === "CANCELLED"
      ? h
      : { ...h, deliveredQty: Math.max(Number(h.deliveredQty ?? 0), Number(h.qty)) },
  );
}

// The carry travels from the replace-all site (before its delete) to the stamp (after the lines are
// written) inside ONE edit transaction: keyed by the transaction object, never shared across edits.
const carries = new WeakMap<object, RecreatedCarry | null>();

/** At a replace-all site, right before its deleteMany. Returns the `lineIdentity` the site assigns. */
export async function markLinesRecreated(
  tx: Prisma.TransactionClient,
  orderId: string,
  held: HeldLine[],
): Promise<"recreated"> {
  carries.set(tx, await captureRecreatedCarry(tx, orderId, held));
  return "recreated";
}

/** `updateOrderItems`' stamp, after its line writes: "recreated" when a site marked it, else "edit". */
export async function stampDeliveredAfterEdit(
  tx: Prisma.TransactionClient,
  orderId: string,
  held: HeldLine[],
  lineIdentity: "stable" | "recreated",
): Promise<number> {
  if (lineIdentity === "stable") return stampDeliveredInFull(tx, orderId, "edit", held);
  const carry = carries.get(tx);
  return carry ? stampDeliveredInFull(tx, orderId, "recreated", carry) : 0;
}

/**
 * The counter sale's DELIVERED write (createSale): status, `deliveredAt` and the stamp in ONE transaction.
 * It bypasses changeStatus on purpose (that fires a second draft invoice), so it books the stamp itself.
 */
export async function markSaleDelivered(
  prisma: Pick<PrismaService, "tenantTransaction">,
  orderId: string,
  deliveredAt: Date,
): Promise<void> {
  await prisma.tenantTransaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.DELIVERED, deliveredAt },
    });
    await stampDeliveredInFull(tx, orderId, "entry");
  });
}

/**
 * Is the order gone, or did it ride a route stop (its columns are never touched)? A caller that already holds the
 * order row under its lock (the void) passes `routeRunStopId` and saves the re-read; `undefined` reads it.
 */
async function ridesRouteStop(
  tx: any,
  orderId: string,
  routeRunStopId: string | null | undefined,
): Promise<boolean> {
  if (routeRunStopId !== undefined) return !!routeRunStopId;
  const order: { routeRunStopId: string | null } | null = await tx.order.findUnique({
    where: { id: orderId },
    select: { routeRunStopId: true },
  });
  return !order || !!order.routeRunStopId;
}

/**
 * The counter-sale void undoes the hand-over. A counter sale hands the goods over at the till, with no route and no
 * evidence row, and the cancel unwind (cancelOrderInTx -> settleStockForEdit) keeps DELIVERED units booked: a line that
 * reads `deliveredQty = qty` would be cancelled with NOTHING restocked. Today's createSale stamps no deliveredQty
 * (B1050), so this is a no-op on master; it is the net for a DELIVERED write that does stamp it (POS mode).
 *
 * Runs inside the void's transaction after the Order lock and BEFORE the cancel; zeroes `deliveredQty` ONLY on live
 * lines WITHOUT evidence. A line with evidence is never rewritten, and an order that rode a route stop
 * (`routeRunStopId`) is not touched at all. Only the counter-sale void imports it (the generic office cancel and the
 * demotion keep the stamp, structure-pinned in counter-sale-void-handover.structure.spec.ts). Returns the zeroed line ids.
 */
export async function clearUnevidencedDelivered(
  tx: any,
  orderId: string,
  routeRunStopId?: string | null,
): Promise<string[]> {
  if (await ridesRouteStop(tx, orderId, routeRunStopId)) return [];
  const handed: Array<{ id: string }> = await tx.orderItem.findMany({
    where: { orderId, deliveredQty: { gt: 0 }, status: { not: "CANCELLED" } },
    select: { id: true },
  });
  if (handed.length === 0) return [];
  const basis = await deliveredBasisByLine(tx, orderId);
  const ids = handed.map((l) => l.id).filter((id) => !hasDeliveryEvidence(basis, id));
  if (ids.length === 0) return [];
  await tx.orderItem.updateMany({ where: { id: { in: ids }, orderId }, data: { deliveredQty: 0 } });
  return ids;
}

/**
 * The units the stock counter still holds out for the void's no-evidence hand-over lines, read BEFORE
 * `clearUnevidencedDelivered` zeroes their deliveredQty: line id -> deliveredQty (> 0). The stock settle books
 * `max(qty, deliveredQty)` per line, so an edit that cut a stamped counter line (qty 12 -> 10, d stays 12) moved
 * no stock and left 12 booked out; after the clear the cancel would credit only qty (10) and lose 2. The void
 * hands this map to `cancelOrderInTx` (`bookedFloor`), which credits `max(qty, floor)`: the counter ends where it
 * started. Same selection as the clear (live lines, no evidence, never a route-stop order); read-only.
 */
export async function unevidencedDeliveredFloor(
  tx: any,
  orderId: string,
  routeRunStopId?: string | null,
): Promise<Map<string, number>> {
  const floor = new Map<string, number>();
  if (await ridesRouteStop(tx, orderId, routeRunStopId)) return floor;
  const handed: Array<{ id: string; deliveredQty: unknown }> = await tx.orderItem.findMany({
    where: { orderId, deliveredQty: { gt: 0 }, status: { not: "CANCELLED" } },
    select: { id: true, deliveredQty: true },
  });
  if (handed.length === 0) return floor;
  const basis = await deliveredBasisByLine(tx, orderId);
  for (const l of handed)
    if (!hasDeliveryEvidence(basis, l.id)) floor.set(l.id, Number(l.deliveredQty));
  return floor;
}
