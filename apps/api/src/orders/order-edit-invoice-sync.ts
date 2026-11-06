import type { InvoicesService } from "../invoices/invoices.service";
import { RECONCILE_PARTIALS } from "../invoices/invoice-partition";

/**
 * The invoice half of OrdersService.reconcileOrderAfterEdit (verbatim move, SA-065: its file sat at its ceiling).
 *
 * `routing` is passed in rather than derived here: `skipInPlaceResync` depends on which line rows the caller can see
 * (the fold holds the PRE-EDIT snapshot; a replay has only current rows), even though the RULE is shared:
 * `shouldSkipInPlaceResync` in merge-idempotency.ts.
 */
export async function syncInvoicesAfterEdit(
  invoices: InvoicesService,
  orderId: string,
  routing: { postDeliveryEdit: boolean; skipInPlaceResync: boolean },
  actor: string | null,
  staffEdit: boolean,
): Promise<Array<{ invoiceId: string; invoiceNumber: string | null }>> {
  let rebuilt = true; // did a rebuild path restate the invoices? (else the partials follow price edits)
  // Keep the order's linked invoice(s) in lockstep with the edit.
  //  - Undelivered edit: re-sync the open pending-mirror draft at order basis
  //    (no-op when there's no open draft) — unchanged.
  //  - Post-delivery edit (R1): the order may carry SENT / PAID / delivery-batch
  //    invoices, not just an open draft. Rebuild each in place from the edited
  //    lines at order basis, KEEP payments, recompute status/balance, and re-sync
  //    the regulated ledger — so the invoice tracks the correction and simply shows
  //    the new balance. Never blocks (bails on an unclean partition).
  if (routing.postDeliveryEdit) {
    if (!routing.skipInPlaceResync) {
      const resynced = await (actor
        ? invoices.resyncOrderInvoicesForEdit(orderId, undefined, undefined, actor)
        : invoices.resyncOrderInvoicesForEdit(orderId));
      rebuilt = resynced !== null; // null: nothing linked, or an unclean partition (bailed)
    } else {
      rebuilt = false; // partially invoiced: the in-place re-sync is skipped
    }
  } else {
    const res = await invoices.reconcileOrderDraftInvoice(orderId, {
      basis: "order",
      ...(actor ? { actor } : {}),
    });
    rebuilt = res !== null && res !== RECONCILE_PARTIALS;
  }
  // SA-760 Q-760-1 (owner 10-10): where no rebuild restated the invoices, a staff edit's PRICE changes reach
  // the order's DRAFT partials (price only, under the R-1 lock order); issued partials never change.
  const followed = staffEdit && !rebuilt ? await invoices.followPartialPrices(orderId) : null;
  return followed?.issuedPartialsUnchanged ?? [];
}
