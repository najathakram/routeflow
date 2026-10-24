import { InvoiceStatus } from "@prisma/client";

/**
 * Extracted verbatim from InvoicesService (SA-760 R-1 / SA-763r P-3: invoices.service.ts is held under its
 * size-ratchet ceiling). `deps` are the service's own methods. The caller (reconcileOrderDraftInvoice's
 * locked body) already holds the Order row and the order's invoices (SA-760 R-1).
 */
export interface SplitReconcileDeps {
  groupOrderLinesForInvoicing(
    items: Array<{ li: any; remainingQty: number }>,
    db: any,
  ): Promise<Array<{ trackedCategoryId: string | null; category: any; items: any[] }>>;
  rebuildSiblingDrafts(
    order: any,
    pairs: Array<{ draft: any; lines: any[] }>,
    basis: "order" | "delivered",
    db: any,
  ): Promise<any[]>;
}

/**
 * Sibling-aware "order"/"delivered"-basis rebuild for a regulated SEPARATE_INVOICE
 * order whose createSplitInvoices left it with base + -R# open DRAFTs. Partitions the
 * CURRENT (non-cancelled) order lines by category (groupOrderLinesForInvoicing — so an
 * edit that added/removed lines still rebuilds each sibling from its own CURRENT lines,
 * which provenance can't) and rebuilds each draft from only its group. Returns the
 * updated invoices, or NULL when this isn't a clean split it can safely handle (a
 * single draft, a finalized invoice already billing part of the order, a group/draft
 * count mismatch, or an ambiguous category match) — the caller then falls back to the
 * legacy single-draft rebuild.
 */
export async function reconcileSplitOrderDrafts(
  deps: SplitReconcileDeps,
  orderId: string,
  basis: "order" | "delivered",
  db: any,
): Promise<any[] | null> {
  const invoices = await db.invoice.findMany({
    where: { orderId, status: { not: InvoiceStatus.VOID } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      status: true,
      deliveryBatchId: true,
      discount: true,
      shippingFee: true,
      items: { select: { orderItemId: true, trackedCategoryId: true, unitsPerBox: true } },
    },
  });
  const drafts = invoices.filter(
    (i: any) => i.status === InvoiceStatus.DRAFT && i.deliveryBatchId == null,
  );
  if (drafts.length <= 1) return null; // single-group → legacy path (byte-identical)
  // A finalized / delivery-batch invoice already bills part of the order; a full
  // rebuild across the drafts would double-count it. Bail to the legacy path.
  if (invoices.length !== drafts.length) return null;

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

  // Partition CURRENT lines by category (mirrors createSplitInvoices) — each line lands
  // in exactly one group.
  const groups = await deps.groupOrderLinesForInvoicing(
    order.lineItems.map((li: any) => ({ li, remainingQty: 1 })),
    db,
  );
  if (groups.length !== drafts.length) return null;

  // Match each group to its draft by the SEPARATE_INVOICE category snapshot on the
  // draft's items (standard group → the base draft with no such category).
  const sepCatIds = new Set(groups.map((g) => g.trackedCategoryId).filter(Boolean));
  const draftCategory = (d: any): string | null | undefined => {
    const cats = new Set<string>(
      (d.items ?? [])
        .map((it: any) => it.trackedCategoryId)
        .filter((c: any) => c && sepCatIds.has(c)),
    );
    if (cats.size > 1) return undefined; // ambiguous — a draft with two SEPARATE cats
    return cats.size === 1 ? [...cats][0] : null; // null → standard/base draft
  };
  const draftByCat = new Map<string | null, any>();
  for (const d of drafts) {
    const c = draftCategory(d);
    if (c === undefined || draftByCat.has(c)) return null; // ambiguous / duplicate
    draftByCat.set(c, d);
  }
  const pairs: Array<{ draft: any; lines: any[] }> = [];
  for (const g of groups) {
    const d = draftByCat.get(g.trackedCategoryId ?? null);
    if (!d) return null; // a group with no matching draft
    pairs.push({ draft: d, lines: g.items.map((x: any) => x.li) });
  }

  return deps.rebuildSiblingDrafts(order, pairs, basis, db);
}
