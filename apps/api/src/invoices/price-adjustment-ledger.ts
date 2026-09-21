import { InvoiceStatus } from "@prisma/client";
import { computeCategoryTax, roundMoney, type CategoryTaxType } from "@routeflow/pricing";
import type { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { sumConfirmed } from "./payment-predicates";

/**
 * B662: keep the regulated ledger equal to a re-priced invoice, inside the SAME transaction as the invoice
 * write. ONE mechanism per document state (Senior Architect ruling 2026-09-21):
 *   - DRAFT: the very re-sync `update()` uses (`resyncInvoiceLedger`: reverse the net the ledger holds for
 *     each line, then write fresh SALE rows). A correction row hung on a SALE that a draft re-sync later
 *     reverses would be an orphan that double counts, so a draft never gets one.
 *   - ISSUED: an append-only CORRECTION row per re-priced regulated line, booked in the current period and
 *     pointing at the SALE it corrects (`correctSaleForPriceChange`). A filed period is never reopened; an
 *     invoice that later returns to draft re-syncs over the SALE AND its corrections.
 * Ordinary (non-regulated) lines have no ledger row and are skipped either way.
 */
export async function syncLedgerAfterPriceChange(
  deps: {
    ledger: Pick<RegulatedLedgerService, "correctSaleForPriceChange">;
    resync: (invoiceId: string, orderId: string | null, items: any[], db: any) => Promise<void>;
  },
  inv: { id: string; status: string; orderId?: string | null },
  items: any[],
  adjustedItemIds: Set<string>,
  tx: any,
): Promise<void> {
  if (inv.status === InvoiceStatus.DRAFT) {
    if (items.some((li) => li.trackedCategoryId)) {
      await deps.resync(inv.id, inv.orderId ?? null, items, tx);
    }
    return;
  }
  const lines = items
    .filter((li) => li.trackedCategoryId && adjustedItemIds.has(li.id))
    .map((li) => ({
      invoiceItemId: li.id as string,
      qty: Number(li.qty),
      netSales: Number(li.subtotal),
      categoryTax: Number(li.categoryTaxAmount ?? 0),
      boxes: li.boxes ?? null,
      unitsPerBox: li.unitsPerBox ?? null,
      promoFreeUnits: li.promoFreeUnits ?? null,
    }));
  if (lines.length > 0) {
    await deps.ledger.correctSaleForPriceChange({ invoiceId: inv.id, lines, db: tx });
  }
}

/**
 * The per-line writes of `applyPriceAdjustment` (moved here so `invoices.service.ts` holds flat, B662): the
 * new unit price and subtotal, and, for a REGULATED line, the category tax re-derived from the NEW subtotal
 * (F03/R3/T-B57). An exempt customer owes $0 of category tax just as they owe $0 of the regular tax
 * (foldCategoryTax's contract), so re-deriving it would bill excise the creation path correctly zeroed.
 * Pure: it only reads its arguments.
 */
export function buildPriceAdjustmentUpdates(args: {
  items: any[];
  localPriceMap: Map<string, number>;
  categoriesById: Map<string, any>;
  unitsPerBoxByProduct: Map<string, number>;
  isTaxExempt: boolean;
}): Array<{ id: string; data: Record<string, any> }> {
  const { items, localPriceMap, categoriesById, unitsPerBoxByProduct, isTaxExempt } = args;
  // Mirrors orders.service's linePieceQty: a box-split line stores qty already in pieces; a boxed
  // selling-unit line expands by its snapshotted unitsPerBox, falling back to the product's. Unused by
  // PERCENT_OF_SALE (unitBasisQty is ignored there) but correct for an EXCISE_PER_UNIT / PER_VOLUME /
  // DEPOSIT_PER_CONTAINER line.
  const linePieceQty = (li: any): number => {
    const qty = Number(li.qty) || 0;
    if (li.boxes != null) return qty;
    const upb = Number(
      li.unitsPerBox ?? (li.productId ? unitsPerBoxByProduct.get(li.productId) : null) ?? 0,
    );
    return upb > 1 ? qty * upb : qty;
  };
  const updates: Array<{ id: string; data: Record<string, any> }> = [];
  for (const item of items) {
    const newPrice = localPriceMap.get(item.id);
    if (newPrice == null) continue;
    // Recover the line's selling-unit multiplier (box-equivalent for boxed lines, plain qty otherwise)
    // from the existing line so re-pricing keeps boxed proration without needing unitsPerBox here:
    //   beforeDiscount = subtotal + discount = oldUnitPrice * multiplier.
    const oldUnitPrice = Number(item.unitPrice);
    const oldDiscount = Number(item.discount ?? 0);
    const multiplier =
      oldUnitPrice > 0 ? (Number(item.subtotal) + oldDiscount) / oldUnitPrice : Number(item.qty);
    const newSubtotal = roundMoney(newPrice * multiplier - oldDiscount);
    const data: Record<string, any> = { unitPrice: newPrice, subtotal: newSubtotal };
    const category = item.trackedCategoryId ? categoriesById.get(item.trackedCategoryId) : null;
    if (category) {
      data.categoryTaxAmount = isTaxExempt
        ? 0
        : computeCategoryTax({
            taxType: category.taxType as CategoryTaxType,
            rate: Number(category.rate),
            unitBasisQty: linePieceQty(item),
            lineSubtotal: newSubtotal,
            priceIncludesTax: category.priceIncludesTax,
          });
    }
    updates.push({ id: item.id, data });
  }
  return updates;
}

/**
 * The transaction body of `applyPriceAdjustment` (B662), AFTER the line writes (those stay in the service so the
 * order/invoice line-writer coverage scanners still see this writer): recompute the invoice totals from the fresh
 * lines, persist them with the status recomputed from CONFIRMED payments against the NEW total
 * (F03/R4/T-B74: a lowered total a payment already covered must not keep a stale SENT/PARTIAL status; an
 * overpayment needs no special handling, recomputeStatus flips to PAID and balanceDue floors at 0), and sync
 * the regulated ledger, all in `tx` so they commit or fail TOGETHER. Category (excise) tax is persisted per
 * line and is NOT part of taxRate: omitting it would under-bill excise and propagate the shortfall to the
 * linked order. The per-line write honours exemption, so this sum is exemption-correct by construction.
 * paidAt is paired with the status like every sibling status writer, or a PAID invoice keeps paidAt NULL and
 * vanishes from every "status: PAID + paidAt" revenue window.
 */
export async function commitPriceAdjustment(args: {
  inv: any;
  itemUpdates: Array<{ id: string; data: Record<string, any> }>;
  auditLine: string;
  tx: any;
  recomputeStatus: (paid: number, total: number, dueDate: Date | null, status: any) => any;
  ledger: Pick<RegulatedLedgerService, "correctSaleForPriceChange">;
  resync: (invoiceId: string, orderId: string | null, items: any[], db: any) => Promise<void>;
}): Promise<void> {
  const { inv, itemUpdates, auditLine, tx, recomputeStatus } = args;
  const updatedItems: any[] = await tx.invoiceItem.findMany({ where: { invoiceId: inv.id } });
  const subtotal = roundMoney(updatedItems.reduce((s, li) => s + Number(li.subtotal), 0));
  const regularTax = roundMoney(
    updatedItems.reduce((s, li) => s + Number(li.subtotal) * Number(li.taxRate ?? 0), 0),
  );
  const categoryTaxTotal = roundMoney(
    updatedItems.reduce((s, li) => s + Number(li.categoryTaxAmount ?? 0), 0),
  );
  const taxAmount = roundMoney(regularTax + categoryTaxTotal);
  const total = roundMoney(
    subtotal - Number(inv.discount ?? 0) + Number(inv.shippingFee ?? 0) + taxAmount,
  );
  const existingInternal = inv.internalNotes ?? "";
  const newStatus = recomputeStatus(
    sumConfirmed(inv.payments),
    total,
    inv.dueDate ?? null,
    inv.status,
  );
  await tx.invoice.update({
    where: { id: inv.id },
    data: {
      subtotal,
      taxAmount,
      total,
      status: newStatus,
      paidAt: newStatus === InvoiceStatus.PAID ? new Date() : null,
      internalNotes: existingInternal ? `${existingInternal}\n${auditLine}` : auditLine,
    },
  });
  await syncLedgerAfterPriceChange(
    args,
    inv,
    updatedItems,
    new Set(itemUpdates.map((u) => u.id)),
    tx,
  );
}
