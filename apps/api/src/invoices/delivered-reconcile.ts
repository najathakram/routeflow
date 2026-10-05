import { API_ERROR_CODES } from "../common/api-error-codes";
import { PAYABLE } from "./invoice-status-sets";
import { isOrderInvoicesNeedReview } from "./invoice-partition";

export interface DeliveredReconcileDeps {
  findOpenOrderDraft: (orderId: string, tx?: any) => Promise<any>;
  createInvoiceFromOrder: (orderId: string, tx?: any) => Promise<any>;
  rebuildIssuedDepositMirrorOnDelivery: (orderId: string, tx: any) => Promise<void>;
  reconcileOrderDeliveredInvoices: (orderId: string, tx?: any) => Promise<any>;
}

/**
 * B663: per delivered order, ensure a finalized invoice exists — reconcile an open
 * DRAFT "pending mirror" (full-order basis, as changeStatus→DELIVERED does) or a
 * SENT deposit mirror onto the DELIVERED quantities, else create a fresh DRAFT from
 * the order. Extracted out of `recordDeliveryPaymentInTx` (B663) so a completion
 * with NO payment (on-account, amount 0 — the ordinary case for most tenants) still
 * gets this: it must run on EVERY delivery completion, never only when cash changes
 * hands. `recordDeliveryPaymentInTx` no longer does this itself; `completeWithPayment`
 * calls this unconditionally, then calls `recordDeliveryPaymentInTx` only when there
 * is a real payment to record.
 *
 * Lives outside InvoicesService (size-ratchet: B663 pushed invoices.service.ts over its
 * ceiling) — `deps` are the class's own methods, bound by the one-line call site in
 * `InvoicesService.reconcileDeliveredOrdersInTx`.
 *
 * @param reconcileOrderIds the subset of `orderIds` actually delivered in this
 *          completion — only these have their DRAFT/mirror rebuilt on the delivered
 *          quantity. Defaults to all `orderIds`.
 */
export async function reconcileDeliveredOrdersInTx(
  deps: DeliveredReconcileDeps,
  tx: any,
  orderIds: string[],
  reconcileOrderIds?: string[],
  userId?: string,
): Promise<void> {
  // Only orders actually delivered in THIS completion may be rebuilt on the
  // delivered basis. Default to all orderIds for callers that don't distinguish
  // (there are none today) — but the driver path passes the real subset so an
  // order merely linked to the stop yet not delivered here (deliveredQty 0) is
  // never zeroed.
  const reconcileSet = new Set(reconcileOrderIds ?? orderIds);

  // Ensure each delivered order has a DRAFT invoice, then reconcile it to the
  // DELIVERED quantities so short/refused lines bill what was delivered, not
  // the full order. createInvoiceFromOrder makes a DRAFT when the order has no
  // live invoice yet; reconcileOrderDraftInvoice(basis:"delivered") rebuilds it
  // on OrderItem.deliveredQty and telescopes invoicedQty (idempotent with the
  // office from-order flow — a later re-delivery bills only the remainder).
  for (const orderId of orderIds) {
    let draft = await deps.findOpenOrderDraft(orderId, tx);
    if (!draft) {
      const existing = await tx.invoice.findFirst({
        where: { orderId, status: { in: PAYABLE } },
        select: { id: true },
      });
      // Create a fresh DRAFT only when the order has no live invoice at all; if a
      // non-DRAFT invoice already exists (e.g. the office already sent one), leave
      // it alone — there is no draft for this function to reconcile, and the
      // caller's own payment step (recordDeliveryPaymentInTx) still applies cash
      // to whatever invoice(s) are already there.
      if (!existing) {
        try {
          await deps.createInvoiceFromOrder(orderId, tx);
        } catch (err) {
          // SA-687c: the physical status write never depends on the invoice. The review guard throws
          // BEFORE any write, so the tx is intact: skip the create, flag the order for the office in
          // the audit trail (same tx), and let the stop complete. The office's from-order route keeps
          // refusing until the invoices are reviewed.
          if (!isOrderInvoicesNeedReview(err)) throw err;
          await tx.auditLog.create({
            data: {
              userId: userId ?? null,
              action: API_ERROR_CODES.ORDER_INVOICES_NEED_REVIEW,
              entityType: "order",
              entityId: orderId,
              meta: {
                context: "stop-completion",
                note: "invoice not created: invoices need review",
              },
            },
          });
          continue;
        }
        draft = await deps.findOpenOrderDraft(orderId, tx);
      }
    }
    if (!draft && reconcileSet.has(orderId)) {
      // B2 / WP-D1: no open DRAFT, but the order may carry a deposit mirror that was
      // ISSUED (SENT) at placement — it has no draft to find, yet it is still the
      // order's live bill and MUST be restated to what was actually delivered before
      // the cash below lands on it. Otherwise a short/refused delivery collects
      // against the full pre-delivery total. No-op for every other shape.
      await deps.rebuildIssuedDepositMirrorOnDelivery(orderId, tx);
    } else if (draft && reconcileSet.has(orderId)) {
      // Rebuild the order's open DRAFT(s) on the delivered qty, SIBLING-AWARE: a
      // regulated SEPARATE_INVOICE order (base + -R#) has each draft rebuilt from
      // ONLY its own lines, so a short/refused line bills its delivered qty on its
      // own sibling and is never folded onto the base (no double-bill). A
      // single-group order is byte-identical to the group-unaware delivered
      // reconcile. (Replaces the old invoiceCount<=1 skip that left split orders
      // billing the full ordered qty.)
      await deps.reconcileOrderDeliveredInvoices(orderId, tx);
    }
  }
}
