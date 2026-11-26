import { ConflictException } from "@nestjs/common";
import { OrderStatus, UserRole } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import type { CorrectionBasis } from "@routeflow/types";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { basisFromRows, evidenceOrigin, isEvidenceRow } from "../invoices/delivered-basis-by-line";
import { assertOrderEditNotLocked } from "../regulated/filing-lock";
import {
  deliveredLineModes,
  evidenceOfModes,
  type EvidenceRowRead,
  type DeliveredModeInput,
  type DeliveredModes,
} from "./delivered-line-facts";
import { CORRECTABLE_STATUSES, isAdminForCorrection } from "./delivered-line-edit-mode";
import {
  assertDeliveredLinesUntouched,
  entryTouchesLine,
  isLiveDeliveredLine,
  reduceDeliveredLineEntries,
  type DeliveredLockEntry,
  type DeliveredLockLine,
} from "./delivered-line-lock";
import { lockReturnCustomersOf } from "../returns/return-customer-lock";
import { lockInlineReturnCustomer } from "./order-inline-return";
import { resyncsInPlace, type CarrierEditGuard } from "./order-carrier-guard";
import {
  EMPTIES_INVOICE_MESSAGE,
  FILED_MONTH_MESSAGE,
  ORDER_CHANGED_DURING_EDIT_MESSAGE,
  fill,
  lockedCopy,
} from "./delivered-line-copy";
import { needsLivePack, toPieces } from "./order-stock";
import { correctedDeliveredFor, heldDeliveredFor } from "./corrected-delivered";
import { OFFICE_MARKED_NOTE } from "./office-evidence-completion";

/**
 * SA-1506 PR-1a (Amendment 1, C1-C2, B2-B5, B8): the edit-side glue of a delivered-line correction, kept out of
 * `orders.service.ts` (its size ratchet). One `DeliveredLineEdit` per `updateOrderItems` call:
 *  - `assertPre` (advisory, before any side effect) and `assertLocked` (authoritative, on the Order-locked read inside
 *    the edit transaction) load the decisions of `deliveredLineEditMode` and run the B1234 guards with them;
 *  - `reduce` cuts a restated entry to its note / reason (B7) and reads an admin's DELETE as CANCEL (B8);
 *  - `applyCorrections` runs AFTER the per-line writes, in the same transaction: it lowers the delivered column of a
 *    corrected line (or zeroes a taken-off one), restates the line's OFFICE evidence rows in place (never deleting
 *    one), writes the `order.line-corrected` audit row, and returns the `correctedDelivered` map the stock settle reads.
 *
 * A correction only ever LOWERS what was delivered: an admin who raises the quantity leaves the delivered figure
 * where it was (the rest is still to deliver); a cut below it takes the delivered figure down with it.
 */
const EPS = 0.0005;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export interface DeliveredLineEditInput {
  deps: DeliveredModeInput["deps"];
  /** The pre-tx order read (with `lineItems`). */
  order: DeliveredModeInput["order"] & {
    lineItems?: DeliveredModeInput["held"];
    tenantId?: string | null;
  };
  dto: {
    items?: readonly DeliveredLockEntry[];
    replaceAll?: boolean;
    inlineReturn?: unknown;
  };
  user: (DeliveredModeInput["user"] & { sub?: string; impersonatedBy?: string }) | undefined;
  isDiffPayload: boolean;
  prisma: { forTenant(): any; getTenantId(): string | null };
}

export interface DeliveredLineEdit {
  assertPre(): Promise<DeliveredModes>;
  /**
   * The tx's FIRST statement (replaces `lockInlineReturnCustomer`): the customer's returns lock, always for an inline
   * return and, for the pre-transaction lock class (A2 M5), for the correction's own sake.
   */
  lockFirst(
    tx: any,
    inlineRet: Parameters<typeof lockInlineReturnCustomer>[1],
    customerId: string,
  ): Promise<void>;
  assertLocked(tx: any, held: DeliveredModeInput["held"]): Promise<DeliveredModes>;
  /** Call after `assertLocked` (it reads the locked status that decides the strip). */
  reduce<T extends DeliveredLockEntry>(
    modes: DeliveredModes,
    held: DeliveredModeInput["held"],
    items: T[] | undefined,
  ): T[] | undefined;
  /** The two judge inputs (B4/B6): see `judgeEditTail`. Call after `assertLocked`. */
  judgeFlags(
    held: ReadonlyArray<{ status?: unknown; deliveredQty?: unknown }>,
    status: string,
    carrier: CarrierEditGuard,
  ): { routedByHeldLines: boolean; hasCorrectEntry: boolean };
  applyCorrections(
    tx: any,
    modes: DeliveredModes,
    held: ReadonlyArray<CorrectionHeldLine>,
  ): Promise<Map<string, number> | undefined>;
}

export type CorrectionHeldLine = DeliveredLockLine & {
  status?: unknown;
  qty?: unknown;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: unknown;
  unitPrice?: unknown;
  productId?: string | null;
};

export function deliveredLineEdit(i: DeliveredLineEditInput): DeliveredLineEdit {
  const tenantId = i.prisma.getTenantId();
  const modesOn = (db: any, held: DeliveredModeInput["held"], status: string) =>
    deliveredLineModes({ deps: i.deps, db, order: i.order, held, status, user: i.user, tenantId });
  let lockedStatus = i.order.status;
  // A2 M5: the lock class is decided BEFORE the transaction: a tenant admin on a CONFIRMED / PARTIALLY_DELIVERED order that
  // holds a live delivered line. Only that class takes the returns lock for its own sake, so only it may CORRECT.
  const preHolds = holdsLiveDeliveredLine(i.order.lineItems);
  const inLockClass =
    isAdminForCorrection(i.user?.role, !!tenantId) &&
    CORRECTABLE_STATUSES.includes(i.order.status) &&
    preHolds;
  let returnsLockTaken = false;
  const changedDuringEdit = () =>
    new ConflictException({
      code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT,
      message: ORDER_CHANGED_DURING_EDIT_MESSAGE,
    });
  let hasCorrectEntry = false;
  const assertWith = (held: DeliveredModeInput["held"], status: string, modes: DeliveredModes) =>
    assertDeliveredLinesUntouched({ status }, held, i.dto, i.user, i.isDiffPayload, modes);
  return {
    async assertPre() {
      const held = i.order.lineItems ?? [];
      const modes = await modesOn(i.prisma.forTenant(), held, i.order.status);
      assertWith(held, i.order.status, modes);
      return modes;
    },
    async lockFirst(tx, inlineRet, customerId) {
      if (inLockClass) {
        await lockReturnCustomersOf(tx, [i.order.id]);
        returnsLockTaken = true;
      }
      await lockInlineReturnCustomer(tx, inlineRet, customerId);
    },
    async assertLocked(tx, held) {
      // Applicability comes from the status read UNDER the Order lock (a delivery can flip the order after the pre-tx read).
      const locked = await tx.order.findUnique({
        where: { id: i.order.id },
        select: { status: true },
      });
      lockedStatus = locked?.status ?? i.order.status;
      // The routing input read before the transaction must still hold under the lock (A2): same shape as carrierRevertUnderLock.
      // Only for a caller who could correct: everyone else is judged by the old guards on the locked read.
      if (
        isAdminForCorrection(i.user?.role, !!tenantId) &&
        holdsLiveDeliveredLine(held) !== preHolds
      )
        throw changedDuringEdit();
      const modes = await modesOn(tx, held, lockedStatus);
      if (!returnsLockTaken && [...modes.values()].some((d) => d.mode === "CORRECT"))
        throw changedDuringEdit(); // CORRECT under the lock, but the returns lock was not the first statement: nothing is written
      assertWith(held, lockedStatus, modes);
      hasCorrectEntry = correctEntryOf(i.dto.items, held, modes);
      if (hasCorrectEntry) await assertCorrectionMonthOpen(tx, i);
      return modes;
    },
    reduce: (modes, held, items) =>
      reduceDeliveredLineEntries({ status: lockedStatus }, held, items, modes),
    judgeFlags: (held, status, carrier) => ({
      // routed in place BY the held lines alone: neither the status nor the carrier already routed it (so no old edit moves)
      routedByHeldLines: holdsLiveDeliveredLine(held) && !resyncsInPlace(status, carrier, false),
      hasCorrectEntry,
    }),
    applyCorrections: (tx, modes, held) => applyLineCorrections(tx, i, modes, held),
  };
}

/** True when an entry actually changes (or takes off) a CORRECT line: a restated entry is not a correction. */
function correctEntryOf(
  items: readonly DeliveredLockEntry[] | undefined,
  held: DeliveredModeInput["held"],
  modes: DeliveredModes,
): boolean {
  const byId = new Map(held.map((l) => [l.id, l]));
  return (items ?? []).some((e) => {
    const id = e.id ?? e.orderItemId;
    const line = id ? byId.get(id) : undefined;
    return !!line && modes.get(line.id)?.mode === "CORRECT" && entryTouchesLine(e, line);
  });
}

/** C3: a correction that moves money in a filed month stays a 409, judged inside the edit transaction. */
async function assertCorrectionMonthOpen(tx: any, i: DeliveredLineEditInput): Promise<void> {
  try {
    await assertOrderEditNotLocked(tx, i.order.id, i.dto as any, {
      tenantId: (i.user as any)?.tenantId ?? i.prisma.getTenantId(),
      role: i.user?.role,
    });
  } catch (e: any) {
    const periodKey = e?.getResponse?.()?.periodKey;
    if (e instanceof ConflictException && periodKey)
      throw new ConflictException({
        ...(e.getResponse() as object),
        message: fill(FILED_MONTH_MESSAGE, { month: String(periodKey) }),
      });
    throw e;
  }
}

/** One restated evidence row, for the audit row. */
export interface RestatedRow {
  id: string;
  before: number;
  after: number;
}

/**
 * B3: lower a line's OFFICE evidence rows (no route stop, no driver) in place, newest first, so that their sum equals
 * `target`. A row is never deleted: it keeps its type, note and time and carries the lower figure (down to 0). Driver
 * proof, POD, change requests and payments are not touched. Returns what moved.
 */
export async function restateOfficeRows(
  tx: any,
  orderId: string,
  lineId: string,
  target: number,
): Promise<RestatedRow[]> {
  const rows: Array<{ id: string; type: string; quantityDelivered: unknown }> =
    await tx.deliveryMutation.findMany({
      where: { orderId, orderItemId: lineId, routeRunStopId: null, driverId: null },
      select: { id: true, type: true, quantityDelivered: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  const live = rows.filter((m) => isEvidenceRow(m) && m.type !== "REFUSED");
  let excess = r3(live.reduce((s, m) => s + Number(m.quantityDelivered), 0) - target);
  const moved: RestatedRow[] = [];
  for (const m of live) {
    if (excess <= EPS) break;
    const before = Number(m.quantityDelivered);
    const after = r3(Math.max(0, before - excess));
    if (after === before) continue;
    await tx.deliveryMutation.update({ where: { id: m.id }, data: { quantityDelivered: after } });
    moved.push({ id: m.id, before, after });
    excess = r3(excess - (before - after));
  }
  return moved;
}

/**
 * A2 commit 5, the evidence restatement seam (signature fixed for PR-1c): NONE moves the column only (no row is created
 * or deleted: an office "Mark delivered" wrote none); OFFICE restates the line's office rows in place, newest first;
 * ROUTE (a driver or stop's rows) is PR-1c's writer. The decider locks ROUTE in PR-1a, so it is unreachable; if PR-1a's
 * commits ever reached master alone (they never deploy alone, SA-1514 M-d) it answers a typed 409 (LOCKED ROUTE), never a 500.
 */
export async function restateLineEvidence(
  tx: any,
  ctx: {
    orderId: string;
    tenantId: string | null;
    /** The order's evidence rows (the edit's one read) and whether it sits on a stop. */
    evidence: ReadonlyArray<EvidenceRowRead>;
    stopLinked: boolean;
  },
  line: { id: string; productId?: string | null },
  corrected: number,
  basis: CorrectionBasis,
  /** The line's FINAL quantity: a NONE line below it gets ONE office row (SA-1520 M-1). */
  finalQty?: number,
): Promise<RestatedRow[]> {
  if (basis === "NONE") {
    // D' = final qty stays column-only (the reader bills a row-less line in full); a short D' needs a row to bill D'.
    if (finalQty != null && corrected < finalQty - EPS && corrected > EPS) {
      // A5 (i): on a stop the row belongs to the stop (PR-1c's route writer); never a stop-less office row.
      if (ctx.stopLinked)
        throw new ConflictException({
          code: API_ERROR_CODES.LINE_ALREADY_DELIVERED,
          message: lockedCopy("ROUTE"),
        });
      await writeOfficeRow(tx, ctx, line, corrected);
    }
    return [];
  }
  if (basis === "OFFICE") {
    const sum = officeRowSum(ctx.evidence, line.id);
    if (corrected > sum + EPS) {
      await writeOfficeRow(tx, ctx, line, r3(corrected - sum));
      return [];
    }
    return restateOfficeRows(tx, ctx.orderId, line.id, corrected);
  }
  throw new ConflictException({
    code: API_ERROR_CODES.LINE_ALREADY_DELIVERED,
    message: lockedCopy("ROUTE"),
  });
}

/** Sum of the line's OFFICE evidence rows, folded from the edit's one evidence read. */
function officeRowSum(rows: ReadonlyArray<EvidenceRowRead>, lineId: string): number {
  return r3(
    rows
      .filter(
        (m) =>
          m.orderItemId === lineId &&
          isEvidenceRow(m) &&
          evidenceOrigin(m) === "office" &&
          m.type !== "REFUSED",
      )
      .reduce((s, m) => s + Number(m.quantityDelivered), 0),
  );
}

/** ONE office DELIVERED row (no stop, no driver), the same shape `completeOfficeEvidencedLines` writes. */
async function writeOfficeRow(
  tx: any,
  ctx: { orderId: string; tenantId: string | null },
  line: { id: string; productId?: string | null },
  quantityDelivered: number,
): Promise<void> {
  // P-3: DeliveryMutation.tenantId is nullable in the schema; a row this writer makes always names its tenant.
  if (!ctx.tenantId) throw new Error("writeOfficeRow: the order's tenantId is required");
  await tx.deliveryMutation.create({
    data: {
      orderId: ctx.orderId,
      tenantId: ctx.tenantId,
      orderItemId: line.id,
      productId: line.productId ?? null,
      routeRunStopId: null,
      driverId: null,
      type: "DELIVERED",
      quantityDelivered,
      note: OFFICE_MARKED_NOTE,
    },
  });
}

/** The booked pieces of one line at a quantity (max(qty, delivered) is the caller's), as the stock settle sizes it. */
const piecesAt = (li: CorrectionHeldLine, qty: unknown, livePack: unknown): number =>
  needsLivePack(li) ? toPieces({ boxes: null }, qty, livePack) : toPieces(li, qty, undefined);

async function applyLineCorrections(
  tx: any,
  i: DeliveredLineEditInput,
  modes: DeliveredModes,
  held: ReadonlyArray<CorrectionHeldLine>,
): Promise<Map<string, number> | undefined> {
  const corrected = new Map<string, number>();
  const ids = held.filter((l) => modes.get(l.id)?.mode === "CORRECT").map((l) => l.id);
  if (ids.length === 0) return undefined; // an ordinary edit hands the stock settle exactly what it always did
  const afterRows: CorrectionHeldLine[] = await tx.orderItem.findMany({
    where: { id: { in: ids }, orderId: i.order.id },
  });
  const afterById = new Map(afterRows.map((a) => [a.id, a]));
  // The evidence read ONCE under the Order lock (A5 j): the decisions' own rows, folded here; the line writes leave evidence alone.
  const loaded = evidenceOfModes(modes) ?? { rows: [], stopLinked: false };
  const basis = basisFromRows(loaded.rows);
  for (const h of held) {
    const a = afterById.get(h.id);
    if (!a || modes.get(h.id)?.mode !== "CORRECT") continue;
    const struck = a.status === "CANCELLED" && h.status !== "CANCELLED";
    const money = (v: unknown) => (v == null ? null : roundMoney(Number(v)));
    const changed =
      struck ||
      Number(a.qty) !== Number(h.qty) ||
      (a.boxes ?? null) !== (h.boxes ?? null) ||
      (a.pieces ?? null) !== (h.pieces ?? null) ||
      money(a.unitPrice) !== money(h.unitPrice);
    if (!changed) continue;
    const heldD = Number(h.deliveredQty ?? 0);
    const figure = heldDeliveredFor({ id: h.id, qty: h.qty }, basis);
    const nextD = correctedDeliveredFor(
      { deliveredQty: figure, qty: h.qty },
      { finalQty: Number(a.qty), struck },
    );
    let restated: RestatedRow[] = [];
    if (Math.abs(nextD - heldD) > EPS || Math.abs(nextD - figure) > EPS) {
      await tx.orderItem.update({
        where: { id: h.id, orderId: i.order.id },
        data: { deliveredQty: nextD },
      });
      const d = modes.get(h.id);
      restated = await restateLineEvidence(
        tx,
        {
          orderId: i.order.id,
          tenantId: i.order.tenantId ?? null,
          evidence: loaded.rows,
          stopLinked: loaded.stopLinked,
        },
        h,
        nextD,
        d?.mode === "CORRECT" ? d.basis : "NONE",
        struck ? undefined : Number(a.qty),
      );
      corrected.set(h.id, nextD);
    }
    const product = h.productId
      ? await tx.product.findUnique({ where: { id: h.productId }, select: { unitsPerBox: true } })
      : null;
    const pack = product?.unitsPerBox;
    const bookedBefore = Math.max(piecesAt(h, h.qty, pack), piecesAt(h, heldD, pack));
    const bookedAfter = struck
      ? piecesAt(h, nextD, pack)
      : Math.max(piecesAt(a, a.qty, pack), piecesAt(a, corrected.get(h.id) ?? heldD, pack));
    await tx.auditLog.create({
      data: {
        tenantId: i.order.tenantId ?? null,
        userId: i.user?.sub ?? null,
        impersonatedBy: i.user?.impersonatedBy ?? null,
        action: AUDIT_ACTIONS.ORDER_LINE_CORRECTED,
        entityType: "Order",
        entityId: i.order.id,
        meta: {
          actor: i.user?.sub ?? null,
          impersonatedBy: i.user?.impersonatedBy ?? null,
          orderId: i.order.id,
          lineId: h.id,
          taken_off: struck,
          qty: { before: Number(h.qty), after: Number(a.qty) },
          boxes: { before: h.boxes ?? null, after: a.boxes ?? null },
          pieces: { before: h.pieces ?? null, after: a.pieces ?? null },
          unitPrice: { before: money(h.unitPrice), after: money(a.unitPrice) },
          deliveredQty: { before: heldD, after: corrected.get(h.id) ?? heldD },
          evidenceRows: restated,
          stockDeltaPieces: r3(bookedBefore - bookedAfter),
        },
      },
    });
  }
  await assertInvoiceKeepsALine(tx, i.order.id);
  return corrected.size > 0 ? corrected : undefined;
}

/** AD-3: an edit that leaves an invoiced order with no live line is a 409 (the tx rolls back: 0 writes). The step is the void. */
async function assertInvoiceKeepsALine(tx: any, orderId: string): Promise<void> {
  const live = await tx.orderItem.count({ where: { orderId, status: { not: "CANCELLED" } } });
  if (live > 0) return;
  const inv: { invoiceNumber: string } | null = await tx.invoice.findFirst({
    where: { orderId, status: { notIn: ["VOID"] } },
    select: { invoiceNumber: true },
    orderBy: { id: "asc" },
  });
  if (!inv) return;
  throw new ConflictException({
    code: API_ERROR_CODES.ORDER_EDIT_EMPTIES_INVOICE,
    message: fill(EMPTIES_INVOICE_MESSAGE, { invoiceNumber: inv.invoiceNumber }),
    invoiceNumber: inv.invoiceNumber,
  });
}

/**
 * B4: the Order's own status flip. A CONFIRMED order whose run has not dispatched goes back to PENDING on an edit, unless
 * the edit routes in place (a reopened order that holds a live delivered line, or one with the carrier), where a PENDING
 * flip would rewind a delivery the order still carries. A driver's edit never flips it.
 */
export function confirmedEditReverts(
  order: { status: string },
  runDispatched: boolean,
  user: { role?: string } | undefined,
  postDeliveryEdit: boolean,
): boolean {
  return (
    order.status === OrderStatus.CONFIRMED &&
    !runDispatched &&
    user?.role !== UserRole.DRIVER &&
    !postDeliveryEdit
  );
}

/** True when any HELD line is a live delivered line: the third input of `resyncsInPlace`. */
export const holdsLiveDeliveredLine = (
  lines: ReadonlyArray<{ status?: unknown; deliveredQty?: unknown }> | undefined,
): boolean => (lines ?? []).some(isLiveDeliveredLine);
