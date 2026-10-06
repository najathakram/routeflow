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
import { mergeInProgress } from "./merge-contention";
import { sameFulfilPathAsWinner, unshipped } from "./merge-candidates";
import * as unitAware from "./unit-aware-guard";

export type MergeKind = "auto" | "force";
export type MergeOrder = Prisma.OrderGetPayload<{ include: { lineItems: true } }>;

/** Wait budget for the WRITE phase only; the acquisition itself never waits (NOWAIT). */
export const MERGE_WRITE_LOCK_TIMEOUT = "3s";

/** Billed documents: a loser carrying one is a real bill / sale and is never deleted by a merge. */
const BILLED_INVOICE = { status: { notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOID] } };

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
      };
}

/** The loser delete's own predicate: `force` has already removed the open DRAFT mirror by then. */
function loserDeleteWhere(kind: MergeKind): Prisma.OrderWhereInput {
  return mergeEligibleWhere(kind);
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
  // a SHIP order never folds into a ROUTE one; a post-create sweep folds only the new order's path
  const group = sameFulfilPathAsWinner(
    unshipped(found),
    kind === "auto" ? focusOrderId : undefined,
  );
  return {
    group,
    unitAware: group.length > 1 && group.some((o) => o.lineItems.some(unitAware.isUnitAwareLine)),
  };
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

/** Delete one loser by id AND its eligibility predicate; anything but exactly one row aborts the fold. */
export async function deleteLoserGuarded(tx: any, loserId: string, kind: MergeKind) {
  const r = await tx.order.deleteMany({ where: { id: loserId, ...loserDeleteWhere(kind) } });
  if (r.count !== 1) throw mergeInProgress();
}
