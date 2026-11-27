import { ConflictException } from "@nestjs/common";
import { InvoiceStatus, OrderStatus, UserRole } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import type { CorrectionBasis } from "@routeflow/types";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { AfterCommit } from "../common/after-commit";
import type { InvoicesService } from "../invoices/invoices.service";
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
  assertDeliveredToShape,
  entryChangesQuantity,
  entryTouchesLine,
  holdsLiveDeliveredLine,
  reduceDeliveredLineEntries,
  type DeliveredLockEntry,
  type DeliveredLockLine,
} from "./delivered-line-lock";
import { lockReturnCustomersOf } from "../returns/return-customer-lock";
import { lockInlineReturnCustomer } from "./order-inline-return";
import { routedByHeldLines, routingUnderLock, type CarrierEditGuard } from "./order-carrier-guard";
import {
  EMPTIES_INVOICE_MESSAGE,
  FILED_MONTH_MESSAGE,
  ORDER_CHANGED_DURING_EDIT_MESSAGE,
  UNPROJECTED_CUTTING_MESSAGE,
  fill,
  lockedCopy,
} from "./delivered-line-copy";
import { bookedPieces } from "./order-stock";
import { loadLiveUnitsPerBoxByProduct } from "./live-pack-map";
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
 * The corrected delivered figure is `correctedDeliveredFor`'s: a cut below it takes the delivered figure down with it, a
 * take-off (`deliveredTo: 0`) zeroes it, a raise leaves a part-delivered line's figure where it was (the rest is still to
 * deliver) and carries a fully delivered line's figure with its quantity.
 */
const EPS = 0.0005;

/**
 * SA-1544 (as) / A9 9.3 item 5: the edit transaction's budget. The correction lock class (an admin on a CONFIRMED or
 * PARTIALLY_DELIVERED order that holds a live delivered line: a superset of every edit that can restate in the tx) gets
 * 20 s, every other edit 15 s. Both stay under `LONG_BUDGET_MS` (30 s, common/tx-retry.ts) so an expiry (P2028) is retried;
 * exhaustion is the existing 503 LOCK_UNAVAILABLE "Nothing was saved", never a 409.
 */
export const EDIT_TX_BUDGET_MS = { correction: 20_000, other: 15_000 } as const;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export interface DeliveredLineEditInput {
  deps: DeliveredModeInput["deps"] & {
    invoicesService?: Pick<InvoicesService, "resyncOrderInvoicesForEdit">;
  };
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
  /**
   * SA-1536 (ab), §8.4 item 3: an edit whose correction map is not empty restates every live invoice of the order IN the
   * edit transaction (`resyncOrderInvoicesForEdit(orderId, tx, after, actor)`), under the billing lock the edit already
   * holds (no second lock, no new lock order). A null answer while a live invoice exists is the typed 409
   * ORDER_INVOICES_NEED_REVIEW; EVERY throw propagates untouched (SA-1544 (aq)), so a lock or timeout error
   * (40P01, 40001, P2034, P2028) reaches `retryStockTx`. Sets `restatedInTx()` when it restated.
   */
  restateInvoices(tx: any, corrected: Map<string, number> | undefined): Promise<void>;
  /** SA-1544 (ar): this attempt restated the invoices inside the edit tx, so the post-commit tail neither resyncs nor follows prices. */
  restatedInTx(): boolean;
  /** SA-1544 (as): the edit tx options, `EDIT_TX_BUDGET_MS` by lock class. */
  txOptions(): { timeout: number };
  /** Send the invoice-updated emits `restateInvoices` queued; call once, after the edit transaction has committed. */
  flushAfterCommit(): void;
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
  let restated = false;
  const after = new AfterCommit();
  const assertWith = (held: DeliveredModeInput["held"], status: string, modes: DeliveredModes) =>
    assertDeliveredLinesUntouched({ status }, held, i.dto, i.user, i.isDiffPayload, modes);
  return {
    async assertPre() {
      assertDeliveredToShape(i.dto.items);
      const held = i.order.lineItems ?? [];
      const modes = await modesOn(i.prisma.forTenant(), held, i.order.status);
      assertWith(held, i.order.status, modes);
      return modes;
    },
    restatedInTx: () => restated,
    txOptions: () => ({
      timeout: inLockClass ? EDIT_TX_BUDGET_MS.correction : EDIT_TX_BUDGET_MS.other,
    }),
    async restateInvoices(tx, corrected) {
      after.reset();
      restated = false; // one answer per attempt: a retried callback starts clean
      if (!corrected || corrected.size === 0) return;
      const live: Array<{ invoiceNumber: string | null }> = await tx.invoice.findMany({
        where: { orderId: i.order.id, status: { not: InvoiceStatus.VOID } },
        select: { invoiceNumber: true },
        orderBy: { id: "asc" },
        take: 1,
      });
      if (live.length === 0) return; // nothing bills these pieces: nothing to restate
      const needReview = () =>
        new ConflictException({
          code: API_ERROR_CODES.ORDER_INVOICES_NEED_REVIEW,
          message: fill(UNPROJECTED_CUTTING_MESSAGE, { invoiceNumber: live[0].invoiceNumber }),
        });
      const rebuilt = await i.deps.invoicesService!.resyncOrderInvoicesForEdit(
        i.order.id,
        tx,
        after,
        i.user?.sub ?? null,
      ); // no catch: a lock or timeout error is the retry loop's, never "needs review"
      if (rebuilt === null) throw needReview(); // an unclean partition: the invoice cannot be restated
      restated = true;
    },
    flushAfterCommit() {
      after.flush();
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
      // SA-1544 (ap): the routing input read before the transaction must still hold under the lock, for EVERY role.
      routingUnderLock(preHolds, held);
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
      routedByHeldLines: routedByHeldLines(status, carrier, held),
      hasCorrectEntry,
    }),
    applyCorrections: (tx, modes, held) => applyLineCorrections(tx, i, modes, held),
  };
}

/** The `deliveredTo` the edit sent for one line (the DTO allows 0 only, with a take-off). */
function deliveredToOf(items: readonly DeliveredLockEntry[] | undefined, lineId: string) {
  return (items ?? []).find((e) => (e.id ?? e.orderItemId) === lineId)?.deliveredTo ?? null;
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
    /** The order's evidence rows (the edit's one read). */
    evidence: ReadonlyArray<EvidenceRowRead>;
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
      // An order that is or was on a run never reaches here: the decider locks its lines (ROUTE, SA-1533 M-3).
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
  const loaded = evidenceOfModes(modes) ?? { rows: [] };
  const basis = basisFromRows(loaded.rows);
  for (const h of held) {
    const a = afterById.get(h.id);
    if (!a || modes.get(h.id)?.mode !== "CORRECT") continue;
    const struck = a.status === "CANCELLED" && h.status !== "CANCELLED";
    const money = (v: unknown) => (v == null ? null : roundMoney(Number(v)));
    // SA-1546 (bb): a delivered figure moves only when the entry changed a quantity (qty, boxes, pieces) or took the line
    // off. A price is never a delivered statement: a price-only entry keeps the column, the rows and the map untouched
    // (the price lands through the write loop; the audit row still records it, delivered before = after).
    // SA-1546 M3: read from the ENTRY as sent against the held line, never from the row after the write (a legacy non-canonical
    // split is rewritten by the write loop, so the after row can differ although the entry named only a price).
    const entry = (i.dto.items ?? []).find((e) => (e.id ?? e.orderItemId) === h.id);
    const quantityChanged = struck || (entry != null && entryChangesQuantity(entry, h));
    if (!quantityChanged && money(a.unitPrice) === money(h.unitPrice)) continue;
    const heldD = Number(h.deliveredQty ?? 0);
    const figure = heldDeliveredFor({ id: h.id, qty: h.qty }, basis);
    const nextD = correctedDeliveredFor(
      { deliveredQty: figure, qty: h.qty },
      { finalQty: Number(a.qty), struck, deliveredTo: deliveredToOf(i.dto.items, h.id) },
    );
    let restated: RestatedRow[] = [];
    if (quantityChanged && (Math.abs(nextD - heldD) > EPS || Math.abs(nextD - figure) > EPS)) {
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
        },
        h,
        nextD,
        d?.mode === "CORRECT" ? d.basis : "NONE",
        struck ? undefined : Number(a.qty),
      );
      corrected.set(h.id, nextD);
    }
    // The live pack comes through the one map the stock settle reads (R-358), never a second direct product read.
    const pack = h.productId
      ? (await loadLiveUnitsPerBoxByProduct(tx, [h.productId])).get(h.productId)
      : undefined;
    // SA-1533 (w): the booking rule has ONE home (`bookedTerms`, through `bookedPieces`), with the same map the stock settle
    // reads, so the audit row's delta can never drift from what the counter moved.
    const booked = bookedPieces(
      [{ ...h, qty: h.qty }],
      struck ? [] : [{ ...a, qty: a.qty }],
      pack,
      "stable",
      corrected,
    );
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
          stockDeltaPieces: r3(booked.before - booked.after),
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
