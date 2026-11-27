import { ConflictException } from "@nestjs/common";
import { InvoiceStatus, UserRole } from "@prisma/client";
import {
  BLOCKING_PAYMENT,
  CASH_METHOD_FILTER,
  OVERPAID_EPSILON,
  roundMoney,
} from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { withOrderBillingLock } from "../invoices/order-billing-lock";
import { shouldSkipInPlaceResync } from "./merge-idempotency";
import {
  CORRECT_OVERPAY_MESSAGE,
  UNPROJECTED_ADDING_MESSAGE,
  UNPROJECTED_CUTTING_MESSAGE,
  fill,
  lockedCopy,
} from "./delivered-line-copy";

/**
 * SA-763r P-3 (M4 + M5): an order edit can never create an overpayment, judged PER INVOICE under the invoice
 * locks, at the TAIL of the edit transaction (after the order's subtotal, tax and shipping fee are written, so
 * the projection reads the in-tx order row). A refusal rolls the whole edit back (nothing written).
 *
 *  1. Lock: the Order row (the edit already holds it), then the order's invoices FOR UPDATE id-sorted
 *     (SA-760 R-1). `recordPayment` / `recordStandalonePayment` take the same rows, so a concurrent payment
 *     waits; either the edit sees it (409) or it commits first and the payment's own capacity check applies.
 *  2. Project each live invoice's post-edit total with the writers' own planners (`projectEditedInvoiceTotals`:
 *     the re-sync builder in plan mode, plus the DRAFT partials the price-follow would re-price), so the NSF
 *     fee lines, the per-invoice discount and the shipping fee are all in the figure.
 *  3. Count EXTERNAL payments only: not CREDIT_NOTE / ADVANCE (those are re-settled right after by the credit
 *     sync), but including in-flight DRAFT / PENDING checks (the same set the capacity check counts), so a
 *     pending check that later clears can never overpay.
 *  4. paid > projectedTotal + OVERPAID_EPSILON (half a cent) on any invoice: 409 ORDER_EDIT_WOULD_OVERPAY, body
 *     {invoiceId, paid, projectedTotal, excess}. Increases are always allowed.
 *
 * Refuse-then-return: a cut after hand-over means goods came back, so a Return records the restock and the
 * refund / store credit; the edit never turns into an unrecorded overpayment.
 */
export interface OverpayJudgeScope {
  /** A post-delivery edit whose invoices the in-place re-sync will restate (not `skipInPlaceResync`). */
  resync: boolean;
  /** A staff edit whose DRAFT partials the price-follow will re-price. */
  partials: boolean;
  /** SA-956: the Order row's total before this edit wrote, read in-tx under the Order lock (the fallback judges a CUT only). */
  priorOrderTotal?: number;
  /**
   * SA-1506 PR-1a (B6): the edit is routed in place BY A HELD LIVE DELIVERED LINE (a reopened order), or carries a
   * CORRECT entry. Then a live invoice the projection cannot reach (a manual line, lost provenance) is a 409 inside
   * this transaction: the restatement bails after commit otherwise, with stock already moved.
   */
  requireFullProjection?: boolean;
  /** SA-1506 PR-1a (B6): the in-place routing is new (held-line routing): a WRITTEN_OFF invoice is never rewritten. */
  refuseWrittenOff?: boolean;
  /** SA-1506 PR-1a: the words of the overpay refusal when an admin correction is the edit (SA-C change 3). */
  overpayMessage?: string;
}

const OVERPAY_MESSAGE =
  "This change would leave an invoice paid beyond its new total. If the goods came back, " +
  "record a return instead of cutting the order.";

export async function assertEditCannotOverpay(
  deps: {
    invoices: {
      projectEditedInvoiceTotals(
        tx: any,
        orderId: string,
        scope: OverpayJudgeScope,
      ): Promise<Array<{ invoiceId: string; projectedTotal: number }>>;
    };
    tenantId: string | null;
  },
  tx: any,
  orderId: string,
  scope: OverpayJudgeScope,
): Promise<void> {
  if (!scope.resync && !scope.partials) return; // nothing is restated: nothing can become overpaid
  if (typeof deps.invoices?.projectEditedInvoiceTotals !== "function")
    throw new Error(
      "assertEditCannotOverpay: the invoices dependency has no projectEditedInvoiceTotals. OrdersService must be " +
        "built with the real InvoicesService (Nest DI does) or a complete fake (orders/testing/invoice-edit-stubs.ts).",
    );
  await withOrderBillingLock(tx, deps.tenantId, orderId);
  if (scope.resync && scope.refuseWrittenOff) await assertNoWrittenOffInvoice(tx, orderId);
  const projected = await deps.invoices.projectEditedInvoiceTotals(tx, orderId, scope);
  if (scope.resync)
    await assertOrderTotalCoversUnprojected(tx, orderId, projected, scope.priorOrderTotal, scope);
  if (projected.length === 0) return;
  const payments: Array<{ invoiceId: string; amount: unknown }> = await tx.invoicePayment.findMany({
    where: {
      invoiceId: { in: projected.map((p) => p.invoiceId) },
      ...BLOCKING_PAYMENT, // PAID + the in-flight DRAFT / PENDING
      method: CASH_METHOD_FILTER, // external only: not CREDIT_NOTE / ADVANCE
    },
    select: { invoiceId: true, amount: true },
  });
  const paidBy = new Map<string, number>();
  for (const p of payments)
    paidBy.set(p.invoiceId, (paidBy.get(p.invoiceId) ?? 0) + Number(p.amount));
  for (const p of [...projected].sort((a, b) => (a.invoiceId < b.invoiceId ? -1 : 1))) {
    const paid = roundMoney(paidBy.get(p.invoiceId) ?? 0);
    const projectedTotal = roundMoney(p.projectedTotal);
    if (paid > projectedTotal + OVERPAID_EPSILON)
      throw new ConflictException({
        code: API_ERROR_CODES.ORDER_EDIT_WOULD_OVERPAY,
        message: scope.overpayMessage ?? OVERPAY_MESSAGE,
        invoiceId: p.invoiceId,
        paid,
        projectedTotal,
        excess: roundMoney(paid - projectedTotal),
      });
  }
}

/** SA-1506 PR-1a (B6): an edit routed in place by a held delivered line never rewrites a WRITTEN_OFF invoice (every role). */
async function assertNoWrittenOffInvoice(tx: any, orderId: string): Promise<void> {
  const off: { invoiceNumber: string } | null = await tx.invoice.findFirst({
    where: { orderId, status: InvoiceStatus.WRITTEN_OFF },
    select: { invoiceNumber: true },
    orderBy: { id: "asc" },
  });
  if (off)
    throw new ConflictException({
      code: API_ERROR_CODES.INVOICE_ALREADY_WRITTEN_OFF,
      message: lockedCopy("WRITTEN_OFF", { invoiceNumber: off.invoiceNumber }),
    });
}

/**
 * W-871 (SA-948 §2 MUST 2, amended by SA-956 Fix 1): fail closed, but only on a CUT. A re-sync that restates the invoices
 * projects EVERY live invoice (`loadResyncInputs` pairs them all) or none (an unclean partition: a manual line, a line
 * whose provenance was lost); "none" never means "nothing to judge". When a live invoice carrying external money is
 * missing from the projection, the new in-tx ORDER total stands in, and the edit is refused only when it LOWERED the
 * order total (new < prior - half a cent) AND the external money across the order's live invoices exceeds the new
 * total by more than half a cent. An increase, or an edit that leaves the total, always passes: the invoice holds
 * invoice-only lines (a manual charge, an NSF fee) that `order.total` never does, so "paid > order total" alone
 * would refuse them. Reads rows the billing lock holds.
 */
async function assertOrderTotalCoversUnprojected(
  tx: any,
  orderId: string,
  projected: ReadonlyArray<{ invoiceId: string }>,
  priorOrderTotal: number | undefined,
  scope: Pick<OverpayJudgeScope, "requireFullProjection" | "overpayMessage"> = {},
): Promise<void> {
  const live: Array<{ id: string; invoiceNumber?: string }> = await tx.invoice.findMany({
    where: { orderId, status: { not: InvoiceStatus.VOID } },
    select: { id: true, invoiceNumber: true },
    orderBy: { id: "asc" },
  });
  const covered = new Set(projected.map((p) => p.invoiceId));
  if (live.every((i) => covered.has(i.id))) return;
  if (scope.requireFullProjection) {
    // SA-1415 table: the sentence follows the direction of the edit (adding vs cutting what is billed).
    const now = await tx.order.findUnique({ where: { id: orderId }, select: { total: true } });
    const adding =
      priorOrderTotal != null &&
      Number.isFinite(priorOrderTotal) &&
      roundMoney(Number(now?.total ?? 0)) > priorOrderTotal + OVERPAID_EPSILON;
    throw new ConflictException({
      code: API_ERROR_CODES.ORDER_INVOICES_NEED_REVIEW,
      message: fill(adding ? UNPROJECTED_ADDING_MESSAGE : UNPROJECTED_CUTTING_MESSAGE, {
        invoiceNumber: live.find((i) => !covered.has(i.id))?.invoiceNumber,
      }),
    });
  }
  const payments: Array<{ invoiceId: string; amount: unknown }> = await tx.invoicePayment.findMany({
    where: {
      invoiceId: { in: live.map((i) => i.id) },
      ...BLOCKING_PAYMENT,
      method: CASH_METHOD_FILTER,
    },
    select: { invoiceId: true, amount: true },
  });
  const paid = roundMoney(payments.reduce((sum, p) => sum + Number(p.amount), 0));
  if (paid === 0) return;
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { total: true } });
  const projectedTotal = roundMoney(Number(order?.total ?? 0));
  // Only a CUT is judged. An unreadable prior total (not finite) is treated as a cut: fail closed.
  const prior = priorOrderTotal;
  const isCut =
    prior == null || !Number.isFinite(prior) || projectedTotal < prior - OVERPAID_EPSILON;
  if (isCut && paid > projectedTotal + OVERPAID_EPSILON) {
    const uncovered = live.find(
      (i) => !covered.has(i.id) && payments.some((p) => p.invoiceId === i.id),
    );
    throw new ConflictException({
      code: API_ERROR_CODES.ORDER_EDIT_WOULD_OVERPAY,
      message: scope.overpayMessage ?? OVERPAY_MESSAGE,
      invoiceId: (uncovered ?? live[0]).id,
      paid,
      projectedTotal,
      excess: roundMoney(paid - projectedTotal),
    });
  }
}

/**
 * updateOrderItems' tail call: derive the judge's scope from the edit and run it. `skipInPlaceResync` is
 * computed from the in-tx HELD lines (read under the Order lock, before any write), never the pre-lock snapshot:
 * a partially-invoiced DELIVERED order's issued invoices are not restated, so only its DRAFT partials (a staff
 * edit's price changes) can be affected. Returns that skip decision for the post-commit re-sync routing.
 */
export async function judgeEditTail(
  deps: Parameters<typeof assertEditCannotOverpay>[0],
  tx: any,
  orderId: string,
  edit: {
    heldItems: ReadonlyArray<{ qty?: unknown; invoicedQty?: unknown }>;
    postDeliveryEdit: boolean;
    role: string | undefined;
    /** SA-956: the Order's total before the edit wrote (read by `lockEditedOrder`). */
    priorOrderTotal?: number;
    /** SA-1506 PR-1a (B4/B6): routed in place by a held live delivered line, not by status or the carrier. */
    routedByHeldLines?: boolean;
    /** SA-1506 PR-1a: the edit carries a CORRECT entry. */
    hasCorrectEntry?: boolean;
  },
): Promise<boolean> {
  const skip = edit.postDeliveryEdit && shouldSkipInPlaceResync(edit.heldItems);
  const staffEdit = edit.role === UserRole.OPERATOR || edit.role === UserRole.TENANT_ADMIN;
  await assertEditCannotOverpay(deps, tx, orderId, {
    resync: edit.postDeliveryEdit && !skip, // the in-place re-sync will restate the invoices
    // A staff edit may reach the DRAFT partials whenever no rebuild restates the invoices (skipped, or the
    // re-sync bails on an unclean partition). Whether it does is decided by projectEditedInvoiceTotals with
    // the SAME predicate the writer uses (reconcileOrderAfterEdit's `rebuilt`), so the scope is a superset.
    partials: staffEdit,
    priorOrderTotal: edit.priorOrderTotal,
    // Only set when true, so an ordinary edit hands the judge exactly the scope it always did.
    ...(edit.routedByHeldLines === true || edit.hasCorrectEntry === true
      ? { requireFullProjection: true }
      : {}),
    ...(edit.routedByHeldLines === true ? { refuseWrittenOff: true } : {}),
    overpayMessage: edit.hasCorrectEntry === true ? CORRECT_OVERPAY_MESSAGE : undefined,
  });
  return skip;
}
