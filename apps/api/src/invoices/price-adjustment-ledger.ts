import { BadRequestException, ConflictException } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import {
  computeCategoryTax,
  regulatedUnitBasis,
  roundMoney,
  type CategoryTaxType,
} from "@routeflow/pricing";
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
  // B679: mirrors orders.service.recomputeLineCategoryTaxes — a box-split line stores qty already in
  // pieces; a boxed selling-unit line expands by its snapshotted unitsPerBox, falling back to the
  // product's. Unused by PERCENT_OF_SALE (unitBasisQty is ignored there) but correct for an
  // EXCISE_PER_UNIT / PER_VOLUME / DEPOSIT_PER_CONTAINER line. Delegates to regulatedUnitBasis
  // (@routeflow/pricing) — the ONE place this conversion happens — instead of an independent copy of
  // its box-unaware fallback branch.
  const linePieceQty = (li: any): number =>
    regulatedUnitBasis(
      { qty: Number(li.qty) || 0, boxes: li.boxes, pieces: li.pieces, unitLabel: li.unitLabel },
      li.unitsPerBox ?? (li.productId ? unitsPerBoxByProduct.get(li.productId) : null) ?? 0,
    ).unitBasisQty;
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
 * The tax reference data for the lines being re-priced, read on the adjustment's own tx from the lines
 * re-read UNDER the Invoice lock (so a line whose category or product changed under the same id is
 * priced against ITS current category and pack, not the pre-lock one).
 *
 * F03/R3/T-B57: the tracked-category tax config for every REGULATED line being re-priced, so a
 * PERCENT_OF_SALE (or other category-taxed) line's categoryTaxAmount is re-derived from its NEW
 * subtotal. Each such line's PRODUCT unitsPerBox too, so linePieceQty can expand a boxed line ordered
 * in SELLING UNITS: create only snapshots unitsPerBox on box-split lines while it computed the ORIGINAL
 * levy from the product's box size, so without this fallback a per-unit levy collapses by a factor of
 * unitsPerBox on the first re-price (the same fetch orders.service.recomputeLineCategoryTaxes carries).
 */
export async function loadPriceAdjustmentReference(
  tx: any,
  items: any[],
  localPriceMap: Map<string, number>,
): Promise<{
  categoriesById: Map<string, any>;
  unitsPerBoxByProduct: Map<string, number>;
}> {
  const regulated = items.filter((i) => localPriceMap.get(i.id) != null && i.trackedCategoryId);
  const catIds = [...new Set(regulated.map((i) => i.trackedCategoryId as string))];
  const productIds = [...new Set(regulated.map((i) => i.productId).filter(Boolean))] as string[];
  const cats = catIds.length
    ? await tx.trackedCategory.findMany({ where: { id: { in: catIds } } })
    : [];
  const products = productIds.length
    ? await tx.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, unitsPerBox: true },
      })
    : [];
  return {
    categoriesById: new Map<string, any>(cats.map((c: any) => [c.id, c])),
    unitsPerBoxByProduct: new Map<string, number>(
      products.map((pr: any) => [pr.id, Number(pr.unitsPerBox ?? 0)]),
    ),
  };
}

/**
 * The adjustment tx's FIRST statement (N-3): the Invoice row lock, BEFORE any InvoiceItem row is
 * written. The order-edit path takes the Invoice first and its rows after (orders.service
 * resync), so locking the items first here could deadlock against it. Everything the adjustment
 * decides on is then re-read UNDER the lock (N-1/N-2): the status guard is re-checked (a payment or
 * write-off that landed after the pre-lock read is a 409, never an adjustment of a settled invoice),
 * the payments feed the recomputed status, and the returned `items` are the lines the caller builds
 * its writes from. A line added or removed since the pre-lock read is a 409 too: the reference data
 * loaded for the pre-lock lines (categories, pack sizes) would not cover it.
 */
export async function lockInvoiceForPriceAdjustment(tx: any, inv: any): Promise<any> {
  await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${inv.id} FOR UPDATE`;
  const live = await tx.invoice.findUnique({
    where: { id: inv.id },
    include: { items: true, payments: true },
  });
  if (!live) return inv;
  if (
    live.status === InvoiceStatus.PAID ||
    live.status === InvoiceStatus.WRITTEN_OFF ||
    live.status === InvoiceStatus.VOID
  ) {
    throw new ConflictException(
      `The invoice became ${live.status} while the price was being adjusted. Issue a credit note instead.`,
    );
  }
  const ids = (rows: any[]) =>
    rows
      .map((r) => r.id)
      .sort()
      .join("|");
  if (ids(live.items ?? []) !== ids(inv.items ?? [])) {
    throw new ConflictException(
      "The invoice's lines changed while the price was being adjusted. Retry.",
    );
  }
  return { ...inv, ...live };
}

/**
 * B1051: a price adjustment must never take an invoice's total BELOW what the customer has already paid
 * (CONFIRMED payments, the same basis the status recompute uses, read under the Invoice lock). A settled
 * (PAID) invoice is refused up front with "issue a credit note instead"; a re-price that would MAKE the
 * invoice overpaid is the same act and gets the same answer. Both sides are rounded to cents before the
 * comparison (L-170), so paid == new total is NOT an overpayment and still settles PAID.
 */
export function assertNotOverpaidByPriceChange(confirmedPaid: number, newTotal: number): void {
  const paid = roundMoney(confirmedPaid);
  const overpaidBy = roundMoney(paid - newTotal);
  if (overpaidBy > 0) {
    throw new BadRequestException(
      `This price change would leave the invoice overpaid by $${overpaidBy.toFixed(2)} ` +
        `(paid $${paid.toFixed(2)}, new total $${newTotal.toFixed(2)}). ` +
        `Issue a credit note instead.`,
    );
  }
}

/**
 * The transaction body of `applyPriceAdjustment` (B662), AFTER the line writes (those stay in the service so the
 * order/invoice line-writer coverage scanners still see this writer): recompute the invoice totals from the fresh
 * lines, persist them with the status recomputed from CONFIRMED payments against the NEW total
 * (F03/R4/T-B74: a lowered total a payment already covered must not keep a stale SENT/PARTIAL status), and
 * sync the regulated ledger, all in `tx` so they commit or fail TOGETHER. B1051: a total BELOW the CONFIRMED
 * payments is refused (`assertNotOverpaidByPriceChange`), never written: recomputeStatus would land PAID and
 * balanceDue floors at 0, so the customer's overpayment would show nowhere. The refusal throws before any
 * write of this function, and the caller's line writes roll back with it. Category (excise) tax is persisted per
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
  const confirmedPaid = sumConfirmed(inv.payments);
  assertNotOverpaidByPriceChange(confirmedPaid, total); // B1051: before ANY invoice or ledger write
  const newStatus = recomputeStatus(confirmedPaid, total, inv.dueDate ?? null, inv.status);
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
