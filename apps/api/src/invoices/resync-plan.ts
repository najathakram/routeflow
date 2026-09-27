import { InvoiceStatus } from "@prisma/client";

/**
 * The pure planning half of `InvoicesService.resyncOrderInvoicesForEdit` (post-delivery order edit
 * → rebuild every linked invoice from the order), extracted verbatim so the service stays under its
 * size ratchet (SA-065). No database access here: the service reads, these decide, the service
 * writes via rebuildSiblingDrafts.
 */

/**
 * Map each order line → the ONE invoice that already bills it, or null when the partition is
 * unclean and the resync must bail:
 * - a provenance-less (manual/freeform) line: we can't prove which order line it bills, so we
 *   can't safely rebuild it;
 * - a line shared by two invoices (double-bill risk).
 */
export function partitionInvoiceLines(
  invoices: Array<{ id: string; items?: Array<{ orderItemId?: string | null }> }>,
): Map<string, string> | null {
  const hasUntracked = (i: any) => (i.items ?? []).some((it: any) => !it.orderItemId);
  if (invoices.some(hasUntracked)) return null;

  const invoiceByLine = new Map<string, string>();
  for (const inv of invoices) {
    for (const it of inv.items ?? []) {
      const oid = it.orderItemId as string;
      if (invoiceByLine.has(oid)) return null; // shared → unclean
      invoiceByLine.set(oid, inv.id);
    }
  }
  return invoiceByLine;
}

/**
 * Pair every invoice with the order lines it should bill after the edit.
 * - A line already billed keeps its invoice (`invoiceByLine`).
 * - A NEW (unprovenanced) line attaches to the invoice that already bills its regulated category
 *   ("" = standard), so a SEPARATE_INVOICE split keeps regulated lines on their -R# sibling
 *   instead of co-mingling onto the base. A category billed by two invoices is ambiguous, so its
 *   new lines fall back to the primary.
 * - Primary = the sole open pending mirror (DRAFT, no delivery batch) if present, else the earliest
 *   invoice. For a single-invoice order that is simply that invoice, so it bills every line.
 */
export function planResyncPairs(
  invoices: Array<{ id: string; status: InvoiceStatus; deliveryBatchId?: string | null }>,
  lineItems: Array<{ id: string; trackedCategoryId?: string | null }>,
  invoiceByLine: Map<string, string>,
): Array<{ draft: any; lines: any[] }> {
  const primaryId =
    invoices.find((i) => i.status === InvoiceStatus.DRAFT && i.deliveryBatchId == null)?.id ??
    invoices[0].id;

  const categoryOwner = new Map<string, string>();
  const categoryAmbiguous = new Set<string>();
  for (const li of lineItems) {
    const owner = invoiceByLine.get(li.id);
    if (!owner) continue; // unprovenanced line — nothing to map from yet
    const cat = li.trackedCategoryId ?? "";
    const prev = categoryOwner.get(cat);
    if (prev === undefined) categoryOwner.set(cat, owner);
    else if (prev !== owner) categoryAmbiguous.add(cat);
  }

  const linesByInvoice = new Map<string, any[]>();
  for (const inv of invoices) linesByInvoice.set(inv.id, []);
  for (const li of lineItems) {
    const cat = li.trackedCategoryId ?? "";
    const invId =
      invoiceByLine.get(li.id) ??
      (categoryAmbiguous.has(cat) ? undefined : categoryOwner.get(cat)) ??
      primaryId;
    linesByInvoice.get(invId)!.push(li);
  }
  return invoices.map((inv) => ({ draft: inv, lines: linesByInvoice.get(inv.id) ?? [] }));
}
