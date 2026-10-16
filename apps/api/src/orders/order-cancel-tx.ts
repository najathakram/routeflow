import { ConflictException } from "@nestjs/common";
import { OrderStatus } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { CreditNotesService } from "../credit-notes/credit-notes.service";
import { assertNoCashRefundOnOrder } from "../invoices/invoice-cash-refund-guard";
import type { InvoicesService } from "../invoices/invoices.service";
import { lockedOrderStatus, lockOrderForCancel } from "./order-cancel-impact";
import { CANCELLABLE_FROM } from "./order-status-transitions";
import { throwIfInTransitUnderLock, type CarrierEditGuard } from "./order-carrier-guard";
import { STOCK_SETTLE_SELECT, type StockArgs, type settleStockForEdit } from "./order-stock";

/** The collaborators the cancel unwind needs, bound by the caller (OrdersService passes its own). */
export interface CancelOrderTxDeps {
  /** OrdersService.settleStockForEdit (bound: the service's stock deps are not this module's). */
  settleStockForEdit: (...args: StockArgs<typeof settleStockForEdit>) => Promise<void>;
  creditNotes: Pick<CreditNotesService, "releaseOrderCreditsInTx">;
  invoices: Pick<InvoicesService, "releaseWalletPaymentsInTx" | "voidInvoiceInTx">;
}

export interface CancelOrderTxOptions {
  /** The statuses the order may be cancelled FROM (the compare-and-set set). */
  fromStatuses: readonly OrderStatus[];
  /** The order update the claim writes (status CANCELLED + note/stamp fields). */
  statusUpdateData: Record<string, unknown>;
  /** The carrier guard decided before the tx (null: no carrier check, e.g. a counter sale void). */
  carrier: CarrierEditGuard | null;
  user: JwtPayload;
  /** The event the stock movement records ("CANCEL" for the office cancel). */
  notes: string;
  /**
   * SA-763r: line id -> the units that were booked out for it before a hand-over reset zeroed its deliveredQty
   * (`unevidencedDeliveredFloor`). The stock credit is made on `max(qty, floor)` for those lines, so a cut that
   * left qty below the booked units (stock books max(qty, delivered)) still returns EVERY unit. A VIEW for the
   * credit only: the line row (qty, history) is never written. Absent for the office cancel.
   */
  bookedFloor?: ReadonlyMap<string, number>;
}

/**
 * SA-762r F1: the order-cancel transaction body, moved VERBATIM out of OrdersService.changeStatus (SA-404d,
 * #2255, #2472, B64, SA-404f F2) so the office cancel and the counter-sale void share ONE unwind and one
 * restock path. Runs inside the caller's Serializable tx: lock Order -> Invoices, cash-refund guard, status
 * read under the lock, compare-and-set claim, stock credit, credit + wallet release, invoice voids, item marking.
 * `order` is the unlocked pre-read (only its fields other than `status` are used; the status comes from the lock).
 */
export async function cancelOrderInTx(
  deps: CancelOrderTxDeps,
  tx: any,
  order: { id: string },
  opts: CancelOrderTxOptions,
) {
  const { fromStatuses, statusUpdateData, carrier, user, notes, bookedFloor } = opts;
  const id = order.id;
  await lockOrderForCancel(tx, id);
  await assertNoCashRefundOnOrder(tx, id); // 409 on a cash refund, before any write
  // #2472 (2): decided from the status UNDER the lock, never the unlocked pre-read.
  const lockedStatus = await lockedOrderStatus(tx, id);
  throwIfInTransitUnderLock(carrier, lockedStatus); // #3219 S5
  const cancelReturnsStock = lockedStatus !== OrderStatus.DRAFT;
  const lockedOrder = { ...order, status: lockedStatus };
  // SA-404f F2: compare-and-set on the cancellable set the pre-check used (`fromStatuses`) — a retry after
  // a 40001 caused by a concurrent DELIVERED must never cancel a delivered order.
  const claimed = await tx.order.updateMany({
    where: { id, status: { in: fromStatuses } },
    data: statusUpdateData,
  });
  if (claimed.count === 0)
    throw new ConflictException({
      code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT,
      message: "The order changed while it was being cancelled — review it and try again.",
    });
  const row = (await tx.order.findUnique({ where: { id } }))!; // the locked row, never gone
  if (cancelReturnsStock) {
    let activeItems = await tx.orderItem.findMany({
      where: { orderId: id, status: { not: "CANCELLED" } },
      select: STOCK_SETTLE_SELECT,
    });
    // Return the creation-time decrement, clamped to the undelivered remainder (empty final
    // set), AS the status read under the lock (#2472: a stale DRAFT pre-read would no-op).
    if (bookedFloor)
      activeItems = activeItems.map((li: any) =>
        bookedFloor.has(li.id)
          ? { ...li, qty: Math.max(Number(li.qty), bookedFloor.get(li.id)!) }
          : li,
      );
    await deps.settleStockForEdit(tx, lockedOrder, activeItems, [], user, {
      notes,
    });
  }

  const invoices = await tx.invoice.findMany({
    where: { orderId: id, status: { not: "VOID" } },
    select: { id: true },
  });
  await deps.creditNotes.releaseOrderCreditsInTx(tx, id);
  for (const inv of invoices) {
    await deps.invoices.releaseWalletPaymentsInTx(tx, inv.id);
    await deps.invoices.voidInvoiceInTx(tx, inv.id, id);
  }
  if (cancelReturnsStock) {
    // Mark what this cancel released. Pre-F07 cancels left items untouched
    // and got no stock credit — reopenOrder re-decrements ONLY item-CANCELLED
    // lines, so both eras stay conservation-consistent.
    await tx.orderItem.updateMany({
      where: { orderId: id, status: { not: "CANCELLED" } },
      data: { status: "CANCELLED" },
    });
  }
  return row;
}

/**
 * B284: the lock half of a hard DELETE's stock release. Locks the Order row FIRST (the cancel tx's lock
 * order: Order, then everything else; never take it after an Invoice row), reads the status UNDER the lock
 * and, for an order that holds stock, the lines still booked. Returns them for the caller to hand to
 * `settleStockForEdit(tx, order, lines, [], user, { notes: "DELETE" })` — the SAME unwind the cancel runs —
 * right after the read-only credit pre-check and BEFORE the credit/wallet releases (house order in
 * common/product-locks.ts: Order, then Products, then everything else; the cancel settles before its
 * releases too). Returns null when nothing is booked: a DRAFT never took a decrement, a CANCELLED order
 * was already credited by its cancel, and a DELIVERED order's goods are gone.
 */
export async function lockDeleteLines(tx: any, id: string) {
  // $queryRaw, not $executeRaw: deleteOrder's lock-order pins count its $executeRaw row locks (the Invoice NOWAIT one).
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${id} FOR UPDATE`;
  const status = await lockedOrderStatus(tx, id);
  if (status === OrderStatus.DRAFT || !CANCELLABLE_FROM.includes(status)) return null;
  const lines = await tx.orderItem.findMany({
    where: { orderId: id, status: { not: "CANCELLED" } },
    select: STOCK_SETTLE_SELECT,
  });
  return { order: { id, status }, lines };
}
