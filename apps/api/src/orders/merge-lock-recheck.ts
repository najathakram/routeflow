/**
 * B1053 (SA-704) — the order-merge critical section's ROW-level guard.
 *
 * `withAdvisoryLock("order-merge")` serialises merges with each other, but the writers that race a
 * merge (cancel, route assignment, invoice insert, line edits) never take it. The merge read its
 * eligibility OUTSIDE its write transaction, so an order that became ineligible in between was still
 * folded into the winner and then DELETED by id (the Invoice -> Order FK is ON DELETE SET NULL, so a
 * racing invoice was silently orphaned). This module closes that window in four steps, all before the
 * first write:
 *   1. `FOR UPDATE NOWAIT` on every order in the fold, ORDER BY id (`lockRowsNoWait`). NOWAIT: a
 *      route assignment's per-stop updates can form a deadlock cycle with a WAITING lock; FOR UPDATE
 *      (not NO KEY UPDATE) because it must also conflict with the FK KEY SHARE a racing invoice
 *      insert takes on the order row.
 *   2. `lock_timeout = 3s` for the rest of the tx: a backstop for the write phase only.
 *   3. A SEPARATE statement re-reads the fold group through the SAME shared predicate (never inside the
 *      locking SELECT's WHERE: that would re-evaluate against a different snapshot of the row).
 *   4. The fold INPUTS must be unchanged: ordered ids, each order's updatedAt and a fingerprint of its
 *      lines. Any difference defers as `MERGE_IN_PROGRESS` (the existing contention body, which every
 *      post-commit caller already treats as "deferred").
 * Nothing has been written when any of these refuses, so a client that gets the 409 can retry safely.
 */
import { ConflictException } from "@nestjs/common";
import { InvoiceStatus, ItemStatus, OrderStatus, Prisma } from "@prisma/client";
import { lockRowsNoWait } from "../common/db-locks";
import { isTargetGone, mergeInProgress } from "./merge-contention";
import { sameFulfilPathAsWinner, unshipped } from "./merge-candidates";
import * as unitAware from "./unit-aware-guard";

export type MergeKind = "auto" | "force";
export type MergeOrder = Prisma.OrderGetPayload<{ include: { lineItems: true } }>;

/** Wait budget for the WRITE phase only; the acquisition itself never waits (NOWAIT). */
export const MERGE_WRITE_LOCK_TIMEOUT = "3s";

/** Billed documents: a loser carrying one is a real bill / sale and is never deleted by a merge. */
// A VOID invoice keeps its audit link to the order, so it counts too: only an open DRAFT mirror is removable.
const BILLED_INVOICE = { status: { not: InvoiceStatus.DRAFT } };

/**
 * The ONE eligibility predicate per path (the pre-read, the under-lock re-read and the guarded loser
 * delete all use it). `auto` (sweep / buyer / templates): a plain pending order, no route, invoice, sale
 * or return. `force` (staff consolidate): any pending order, but never one with a billed Invoice
 * (SENT/PAID/...) or a Transaction (the FK SET NULL would orphan the bill and bill the cart twice); an
 * open DRAFT mirror invoice is the B214 exception (it is removed with the loser).
 */
export function mergeEligibleWhere(kind: MergeKind): Prisma.OrderWhereInput {
  return kind === "auto"
    ? {
        status: OrderStatus.PENDING,
        routeRunId: null,
        routeRunStopId: null,
        transaction: { is: null },
        invoices: { none: {} },
        returns: { none: {} },
        skipAutoMerge: false,
      }
    : {
        status: OrderStatus.PENDING,
        transaction: { is: null },
        invoices: { none: BILLED_INVOICE },
        returns: { none: {} },
      };
}

/**
 * The loser delete's own predicate. `force` has removed the (single) open DRAFT mirror by then, so it
 * additionally requires NO invoice at all: a second DRAFT partial (pre-delivery partials stay DRAFT) would
 * be orphaned by the FK SET NULL and its lines billed twice, so the delete fails closed.
 */
function loserDeleteWhere(kind: MergeKind): Prisma.OrderWhereInput {
  return kind === "force"
    ? { ...mergeEligibleWhere(kind), invoices: { none: {} } }
    : mergeEligibleWhere(kind);
}

/** The fold group exactly as the merge methods compute it, from any client (`forTenant()` or a tx). */
export async function readMergeGroup(
  db: { order: { findMany: (args: any) => Promise<any[]> } },
  customerId: string,
  kind: MergeKind,
  focusOrderId?: string,
): Promise<{ group: MergeOrder[]; unitAware: boolean }> {
  const found: MergeOrder[] = await db.order.findMany({
    where: { customerId, ...mergeEligibleWhere(kind) },
    include: {
      lineItems: {
        where: { status: { not: ItemStatus.CANCELLED } },
        // SA-124e(6): "the FIRST winner line in display order" needs a real order.
        orderBy: { position: "asc" },
      },
    },
    orderBy: { updatedAt: "desc" },
  });
  // force: a loser with MORE THAN ONE DRAFT invoice, or a batch draft, is skipped (the merge removes only one plain mirror)
  const eligible = kind === "force" ? await withoutMultiDraftOrders(db, found) : found;
  // a SHIP order never folds into a ROUTE one; a post-create sweep folds only the new order's path
  const group = sameFulfilPathAsWinner(
    unshipped(eligible),
    kind === "auto" ? focusOrderId : undefined,
  );
  return {
    group,
    unitAware: group.length > 1 && group.some((o) => o.lineItems.some(unitAware.isUnitAwareLine)),
  };
}

async function withoutMultiDraftOrders(db: any, found: MergeOrder[]): Promise<MergeOrder[]> {
  if (found.length === 0) return found;
  const drafts: Array<{ orderId: string | null; deliveryBatchId: string | null }> =
    await db.invoice.findMany({
      where: { orderId: { in: found.map((o) => o.id) }, status: InvoiceStatus.DRAFT },
      select: { orderId: true, deliveryBatchId: true },
    });
  const count = new Map<string | null, number>();
  const skip = new Set<string | null>();
  for (const d of drafts) {
    count.set(d.orderId, (count.get(d.orderId) ?? 0) + 1);
    // a batch draft is never removed by the merge (findOpenOrderDraft skips it): a permanent 409
    if (d.deliveryBatchId != null) skip.add(d.orderId);
  }
  for (const [id, n] of count) if (n > 1) skip.add(id);
  return found.filter((o) => !skip.has(o.id));
}

/** Ordered ids + each order's updatedAt + a fingerprint of its (non-cancelled) lines. */
export function mergeInputFingerprint(group: MergeOrder[]): string {
  return JSON.stringify(
    group.map((o) => [
      o.id,
      new Date(o.updatedAt).toISOString(),
      o.lineItems.map((li) => [
        li.id,
        li.productId,
        li.status,
        String(li.qty),
        String(li.boxes ?? ""),
        String(li.pieces ?? ""),
        String(li.unitsPerBox ?? ""),
        String(li.unitPrice),
        String(li.subtotal),
        String(li.position ?? ""),
        // line-only writers do not bump Order.updatedAt
        String(li.promoFreeUnits ?? ""),
        li.priceType ?? "",
        String(li.originalPrice ?? ""),
      ]),
    ]),
  );
}

/**
 * Steps 1-4 above. Call as the FIRST statement of the merge transaction. `pre` is the group the fold
 * was planned from (the pre-read).
 */
export async function lockAndRecheckMergeInputs(
  tx: any,
  args: { customerId: string; kind: MergeKind; focusOrderId?: string; pre: MergeOrder[] },
): Promise<void> {
  try {
    await lockRowsNoWait(
      tx,
      "Order",
      args.pre.map((o) => o.id),
      "order-merge",
    );
  } catch (e) {
    if (e instanceof ConflictException) throw mergeInProgress(); // 55P03: someone is writing one
    throw e;
  }
  await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`; // = MERGE_WRITE_LOCK_TIMEOUT (a literal: no Unsafe raw)
  const now = await readMergeGroup(tx, args.customerId, args.kind, args.focusOrderId);
  if (now.unitAware || mergeInputFingerprint(now.group) !== mergeInputFingerprint(args.pre)) {
    throw mergeInProgress();
  }
}

/**
 * Delete one loser (its lines, then the order) by id AND its eligibility predicate; anything but exactly
 * one row aborts the fold. Narrow wrap: P2025 / P2003 raised by THESE statements mean a lock-free writer
 * (deleteOrder) removed the target under us, which is contention. The winner needs no such wrap: its row
 * is held FOR UPDATE for the whole tx. Nothing else in the tx is reclassified.
 */
export async function deleteLoserGuarded(tx: any, loserId: string, kind: MergeKind) {
  try {
    await tx.orderItem.deleteMany({ where: { orderId: loserId } });
    const r = await tx.order.deleteMany({ where: { id: loserId, ...loserDeleteWhere(kind) } });
    if (r.count !== 1) throw mergeInProgress();
  } catch (e) {
    if (isTargetGone(e)) throw mergeInProgress();
    throw e;
  }
}
