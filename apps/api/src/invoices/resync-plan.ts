import { InvoiceStatus } from "@prisma/client";
import { isNsfLine, type NsfLineFacts } from "./nsf-line";

/**
 * The pure planning half of `InvoicesService.resyncOrderInvoicesForEdit` (post-delivery order edit
 * → rebuild every linked invoice from the order), extracted verbatim so the service stays under its
 * size ratchet (SA-065). No database access here: the service reads, these decide, the service
 * writes via rebuildSiblingDrafts.
 */

/**
 * The invoice-line fields the resync reads: provenance, the pack snapshot the rebuild keeps
 * (priorUnitsPerBoxMap), and the two `isNsfLine` reads (#2268).
 */
export const RESYNC_ITEM_SELECT = {
  orderItemId: true,
  qty: true, // SA-763r P-3: the revision audit counts changed lines
  subtotal: true,
  unitsPerBox: true,
  systemKind: true,
  description: true,
} as const;

type ResyncItem = NsfLineFacts & { orderItemId?: string | null };

/**
 * Map each order line → the ONE invoice that already bills it, or null when the partition is
 * unclean and the resync must bail:
 * - a provenance-less (manual/freeform) line: we can't prove which order line it bills, so we
 *   can't safely rebuild it;
 * - a line shared by two invoices (double-bill risk).
 *
 * #2268: a system NSF fee line (`isNsfLine`, the shared predicate) is NOT an order line and never
 * makes the partition unclean. It is skipped here, and `rebuildSiblingDrafts` keeps the same row
 * untouched (`preservedNsfLines`, #2242), adding its fee to the rebuilt subtotal and total outside
 * the tax. Before this, one bounced check froze the invoice against every later order edit.
 */
export function partitionInvoiceLines(
  invoices: Array<{ id: string; items?: ResyncItem[] }>,
): Map<string, string> | null {
  const orderLines = (i: { items?: ResyncItem[] }) =>
    (i.items ?? []).filter((it) => !isNsfLine(it));
  if (invoices.some((i) => orderLines(i).some((it) => !it.orderItemId))) return null;

  const invoiceByLine = new Map<string, string>();
  for (const inv of invoices) {
    for (const it of orderLines(inv)) {
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

/**
 * The reads of a post-delivery re-sync (moved out of `InvoicesService.resyncOrderInvoicesForEdit`, SA-763r
 * P-3, so the overpay judge's projection and the writer plan from ONE read): the order's live invoices
 * with the lines they bill and the payments they carry, the order with its live lines, and the planned
 * (invoice, lines) pairs. NULL when there is nothing to re-sync or the partition is unclean (the writer bails).
 * The caller holds the SA-760 R-1 locks.
 */
export async function loadResyncInputs(
  db: any,
  orderId: string,
): Promise<{ order: any; pairs: Array<{ draft: any; lines: any[] }> } | null> {
  const invoices = await db.invoice.findMany({
    where: { orderId, status: { not: InvoiceStatus.VOID } },
    // invoiceNumber tiebreak: split siblings share a createdAt (one tx timestamp),
    // so createdAt alone is non-deterministic for picking the primary/base.
    orderBy: [{ createdAt: "asc" }, { invoiceNumber: "asc" }],
    select: {
      id: true,
      invoiceNumber: true,
      status: true,
      total: true,
      deliveryBatchId: true,
      discount: true,
      shippingFee: true,
      dueDate: true,
      items: { select: RESYNC_ITEM_SELECT }, // #2268: + the NSF-line reads
      payments: { select: { amount: true, status: true } },
    },
  });
  if (invoices.length === 0) return null;
  // Partition lines to invoices; null = unclean (untracked or shared line) -> bail.
  const invoiceByLine = partitionInvoiceLines(invoices);
  if (!invoiceByLine) return null;
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: {
      lineItems: {
        where: { status: { not: "CANCELLED" } },
        include: {
          components: { orderBy: { position: "asc" } },
          product: {
            select: {
              name: true,
              unitsPerBox: true,
              trackedCategoryId: true,
              trackedSubcategoryId: true,
            },
          },
        },
      },
    },
  });
  if (!order) return null;
  return { order, pairs: planResyncPairs(invoices, order.lineItems, invoiceByLine) };
}
