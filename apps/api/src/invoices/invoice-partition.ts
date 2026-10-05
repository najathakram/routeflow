import { InvoiceStatus } from "@prisma/client";

/**
 * The ONE place that decides whether an order's invoices are a clean per-line partition, shared by
 * the delivered-basis rebuild (reconcileOrderDeliveredInvoices) and the legacy single-draft rebuild
 * (reconcileOrderDraftInvoice). SA-681: that legacy rebuild used to fold the OLDEST open draft onto
 * the FULL order while sibling partials kept billing their share (a 10-box order split 6/4 billed
 * 14 boxes). It now runs only for a draft that is the order's sole billing invoice.
 */

/** What reconcileOrderDraftInvoice returns when the order's invoices are partials it must not touch. */
export const RECONCILE_PARTIALS = "partials" as const;
export type ReconcilePartials = typeof RECONCILE_PARTIALS;

export interface PartitionInvoice {
  id?: string;
  status: InvoiceStatus;
  deliveryBatchId?: string | null;
  items?: Array<{ orderItemId?: string | null }> | null;
}

/** An open pending-mirror / sibling draft: DRAFT and not a delivery-batch invoice. */
export const isOpenOrderDraft = (i: PartitionInvoice): boolean =>
  i.status === InvoiceStatus.DRAFT && i.deliveryBatchId == null;

/**
 * True when every order line is billed by exactly ONE of the order's non-void `invoices`, and only
 * by an open draft. Provenance is the invoice item's `orderItemId`. Not clean when:
 *   - any invoice line carries no orderItemId (legacy / freeform): the partition cannot be proven;
 *   - a draft line is also billed by a finalized (non-open-draft) invoice;
 *   - a line is shared across two open drafts (createPartialFromOrder: 6 + 4 of one line).
 * Extracted verbatim from reconcileOrderDeliveredInvoices.
 */
export function isCleanDraftPartition(invoices: PartitionInvoice[]): boolean {
  const drafts = invoices.filter(isOpenOrderDraft);
  const finalized = invoices.filter((i) => !isOpenOrderDraft(i));
  const hasUntracked = (i: PartitionInvoice) => (i.items ?? []).some((it) => !it.orderItemId);
  if (finalized.some(hasUntracked) || drafts.some(hasUntracked)) return false;
  const finalizedLineIds = new Set<string>(
    finalized.flatMap((i) => (i.items ?? []).map((it) => it.orderItemId as string)).filter(Boolean),
  );
  const seen = new Set<string>();
  for (const d of drafts) {
    for (const it of d.items ?? []) {
      const id = it.orderItemId as string;
      if (seen.has(id) || finalizedLineIds.has(id)) return false;
      seen.add(id);
    }
  }
  return true;
}

/**
 * The legacy rebuild's fence: `draftId` is the order's SOLE non-void invoice — the lone-draft case
 * of the clean partition above. The draft's own untracked lines (an NSF fee line, a freeform line)
 * do not disqualify it, because that rebuild preserves them (preservedNsfLines). `invoices` are
 * the order's non-void invoices; an empty list means nothing else bills the order.
 */
export function isSoleBillingDraft(draftId: string, invoices: PartitionInvoice[]): boolean {
  return !invoices.some((i) => i.id !== draftId);
}

/**
 * True when the draft's lines bill LESS than the order's lines — a line missing from it, or billed
 * for part of its qty: the signature of a partial invoice rather than a mirror of the whole order.
 * Only meaningful when nothing has just edited the order (Mark Delivered), because a mirror is only
 * ever short transiently, between an order edit and its own reconcile.
 */
export function draftBillsLessThanOrder(
  draftItems: Array<{ orderItemId?: string | null; qty?: unknown }>,
  orderLines: Array<{ id: string; qty?: unknown }>,
): boolean {
  const billed = new Map<string, number>();
  for (const it of draftItems) {
    if (!it.orderItemId) continue;
    billed.set(it.orderItemId, (billed.get(it.orderItemId) ?? 0) + Number(it.qty ?? 0));
  }
  return orderLines.some((li) => {
    const qty = Number(li.qty ?? 0);
    return qty > 0.001 && (billed.get(li.id) ?? 0) < qty - 0.001;
  });
}
