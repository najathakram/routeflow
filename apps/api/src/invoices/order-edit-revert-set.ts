import { BadRequestException } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { lockRowsNoWait } from "../common/db-locks";
import { carrierEditGuard, resyncsInPlace, type CarrierOrder } from "../orders/order-carrier-guard";

/**
 * #2178 — the ONE selection of the invoices an UNDELIVERED order edit reverts to DRAFT
 * (`InvoicesService.revertLinkedInvoicesForOrderEdit`), lifted out of that method so the inline-return
 * preflight can price against the matching set as it will be AFTER the revert: the revert turns these
 * into DRAFTs of an undelivered order, which the matching set (§3.1) does not include. One predicate,
 * never a second copy.
 *
 * The order's own non-batch SENT/VIEWED/OVERDUE invoices, minus the exempt deposit mirror: a
 * deposit-carrying invoice that is the order's SOLE non-void invoice, on an order not yet
 * DELIVERED/CANCELLED, stays SENT (the widened reconcile re-syncs it, and its payments stay attached
 * to a still-issued document). The fence reads run only when a deposit invoice is in play, so an order
 * with no deposit mirror issues exactly the one query it always did.
 */
export interface EditRevertCandidate {
  id: string;
  invoiceNumber: string;
  internalNotes: string | null;
  depositPercent: unknown;
}

interface RevertSetDb {
  invoice: {
    findMany(args: unknown): Promise<any[]>;
    count(args: unknown): Promise<number>;
  };
  order: { findFirst(args: unknown): Promise<{ status: string } | null> };
}

export async function selectEditRevertedInvoices(
  db: RevertSetDb,
  orderId: string,
): Promise<EditRevertCandidate[]> {
  const linked: EditRevertCandidate[] = await db.invoice.findMany({
    where: {
      orderId,
      deliveryBatchId: null,
      status: { in: [InvoiceStatus.SENT, InvoiceStatus.VIEWED, InvoiceStatus.OVERDUE] },
    },
    select: { id: true, invoiceNumber: true, internalNotes: true, depositPercent: true },
  });
  if (!linked.some((inv) => inv.depositPercent != null)) return linked;
  const order = await db.order.findFirst({ where: { id: orderId }, select: { status: true } });
  const nonVoidCount = await db.invoice.count({
    where: { orderId, status: { not: InvoiceStatus.VOID } },
  });
  const depositMirrorExempt =
    !!order && order.status !== "DELIVERED" && order.status !== "CANCELLED" && nonVoidCount === 1;
  return depositMirrorExempt ? linked.filter((inv) => inv.depositPercent == null) : linked;
}

/**
 * SA-1060 A-4 (M1): the invoices the Returns section's QUOTE must leave out while the operator is editing `orderId`, so the
 * screen prices the same post-revert matching set the edit's dry run and capture do (`preflightCapture`, `revertOrderId`).
 *
 * Reads the order (this customer's, in this tenant: any other is a 400 SOURCE_SALE_INVALID, never a probe) and applies the
 * edit's own routing rule, never a second copy: `resyncsInPlace(order.status, carrierEditGuard)` is true for an order that is out
 * for delivery, partly or fully delivered, or with the carrier, and then nothing reverts, so `[]`. Otherwise the revert runs and
 * the ids are `selectEditRevertedInvoices`' own (the order's non-batch SENT/VIEWED/OVERDUE invoices, minus an exempt deposit
 * mirror). `featureConfig` is the one reader of the business's billing moment, and it is required, so no caller reads as not with the carrier by leaving it out.
 */
export async function quoteExcludedInvoiceIds(
  db: Omit<RevertSetDb, "order"> & {
    order: { findFirst(args: unknown): Promise<any> };
  },
  customerId: string,
  orderId: string,
  featureConfig: Parameters<typeof carrierEditGuard>[0]["featureConfig"],
): Promise<string[]> {
  const order: (CarrierOrder & { id: string; status: string }) | null = await db.order.findFirst({
    where: { id: orderId, customerId },
    select: { id: true, status: true, fulfillPath: true, shippedAt: true, tenantId: true },
  });
  if (!order) {
    throw new BadRequestException({
      code: API_ERROR_CODES.SOURCE_SALE_INVALID,
      message: "That order isn't this customer's.",
    });
  }
  const guard = await carrierEditGuard(
    { featureConfig, prisma: { forTenant: () => db } as any },
    order,
  );
  if (resyncsInPlace(order.status, guard)) return [];
  return (await selectEditRevertedInvoices(db, orderId)).map((inv) => inv.id);
}

/**
 * When an order with a SENT (non-draft) pending-mirror invoice is edited, bring
 * that invoice back to DRAFT so the edit re-syncs into it instead of silently
 * diverging (the "edit after send" price-drift class). Only invoices with ZERO
 * payments are auto-reverted; a paid/partly-paid invoice throws instead — money
 * must never silently detach from a sent document. Per-batch delivery invoices
 * (deliveryBatchId != null, only on delivered orders) are never touched. Returns
 * the reverted invoice ids (empty when there's nothing to revert). Call BEFORE
 * mutating the order, so a payment-block aborts the whole edit cleanly.
 *
 * WP-D1 EXEMPTION (B1): a deposit mirror issued at ORDER PLACEMENT is SENT on
 * purpose and must survive an edit. Reverting it would be IRREVERSIBLE — a
 * pre-delivery order-linked DRAFT can never be re-sent (assertOrderInvoiceUnlocked
 * refuses without the create-path-only `allowPreDelivery` hatch), so the deposit
 * the customer was asked to pay would silently un-issue. It doesn't need reverting
 * either: reconcileOrderDraftInvoice's widened branch keeps exactly this invoice in
 * lockstep with the edit while it stays SENT. The exemption therefore mirrors that
 * branch's fence EXACTLY — deposit-carrying, the order's SOLE non-void invoice, and
 * the order not yet DELIVERED/CANCELLED — so an invoice is skipped here only when
 * the reconcile provably picks it up. Anything outside the fence (split/partial
 * siblings, a delivered order) keeps the legacy revert, including its
 * throw-on-payments guard.
 *
 * `opts.lockRows` takes the SAME Invoice row lock `recordPayment` holds before counting that
 * invoice's payments, so a payment cannot commit between the count and the DRAFT flip. It is
 * opt-in because only a caller already inside a transaction can hold it usefully, and because
 * the row is then held for the rest of that tx — the caller owns keeping Invoice last in the
 * lock order (`lockRowsNoWait`). Contention surfaces as a retryable 409 (NOWAIT), not a wait.
 * The caller clears the display-unit snapshot of each returned id (SA-827 rule 5 / B1275: a DRAFT renders live): the
 * display helpers are named only by the owning services (invoice-unit-display-only.spec.ts, G1).
 * `opts.preflightOnly` (row 586, SA-814a item 4): only the payment-block throw, nothing written, so a caller outside
 * a transaction can refuse a paid mirror early without committing a revert a later binding 409 cannot undo.
 */
export async function revertLinkedInvoicesToDraft(
  db: any,
  orderId: string,
  opts?: { lockRows?: boolean; preflightOnly?: boolean },
): Promise<string[]> {
  // #2178: the ONE selection (incl. the exempt deposit mirror, which stays SENT) — shared with the
  // inline-return preflight, which prices against the matching set as it will be after this revert.
  const linked = await selectEditRevertedInvoices(db, orderId);
  const reverted: string[] = [];
  for (const inv of linked) {
    // Under the caller's tx: hold the row before the count, so the payment-block below reads a
    // state no concurrent recordPayment can change until this tx commits or rolls back.
    if (opts?.lockRows) await lockRowsNoWait(db, "Invoice", [inv.id], "INVOICE_BUSY");
    // B314: same live-payments filter as revertInvoiceToDraft — a VOID (bounced) payment
    // carries no money and must never block an edit that would otherwise revert cleanly.
    // Existence check, not a money sum — see the identical note on revertInvoiceToDraft
    // in invoices.service.ts; a DRAFT payment must still block this edit.
    // scan-ok: draft-payment-not-void — see comment above.
    const paymentCount = await db.invoicePayment.count({
      where: { invoiceId: inv.id, status: { not: "VOID" } },
    });
    if (paymentCount > 0) {
      throw new BadRequestException(
        `This order can't be edited while invoice ${inv.invoiceNumber} has payments recorded. ` +
          `Void the invoice or remove its payments first.`,
      );
    }
    if (opts?.preflightOnly) continue; // row 586: the read-only pre-tx check; the revert runs in the edit tx
    const auditLine = `[${new Date().toLocaleDateString()} — reverted to Draft: source order edited]`;
    await db.invoice.update({
      where: { id: inv.id },
      data: {
        status: InvoiceStatus.DRAFT,
        sentAt: null,
        pdfUrl: null,
        internalNotes: inv.internalNotes ? `${inv.internalNotes}\n${auditLine}` : auditLine,
      },
    });
    reverted.push(inv.id);
  }
  return reverted;
}
