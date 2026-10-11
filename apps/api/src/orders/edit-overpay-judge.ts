import { ConflictException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import {
  BLOCKING_PAYMENT,
  CASH_METHOD_FILTER,
  OVERPAID_EPSILON,
  roundMoney,
} from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { withOrderBillingLock } from "../invoices/order-billing-lock";
import { shouldSkipInPlaceResync } from "./merge-idempotency";

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
}

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
  await withOrderBillingLock(tx, deps.tenantId, orderId);
  const projected = await deps.invoices.projectEditedInvoiceTotals(tx, orderId, scope);
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
        message:
          "This change would leave an invoice paid beyond its new total. If the goods came back, " +
          "record a return instead of cutting the order.",
        invoiceId: p.invoiceId,
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
  });
  return skip;
}
