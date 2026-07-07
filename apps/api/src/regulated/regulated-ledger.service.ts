import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { roundMoney } from "../common/pricing";
import { periodBucketOf } from "./period";

/** Round a quantity to 3 decimals (matches the Decimal(12,3) ledger columns). */
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** One regulated invoice line, as seen at invoice-creation time. */
export interface SaleLedgerLine {
  invoiceItemId: string;
  orderItemId: string | null;
  trackedCategoryId: string | null;
  qty: number;
  netSales: number; // the line's post-discount subtotal
  categoryTax: number; // computed category tax (0 today — tobacco is rate=0)
}

/**
 * Phase 4 (W5): writes the immutable RegulatedSalesLedger — the source of truth
 * for filings. A SALE row (positive) per regulated invoice line at invoice
 * creation; a REVERSAL row (negated) per line when an invoice is voided/deleted.
 * Amounts are pre-signed so a plain SUM() nets to the reportable figure.
 *
 * Netting semantics: a REVERSAL books into the period it happens in (never
 * backdated), so the ALL-periods SUM of a fully-reversed sale is 0, and each
 * period's SUM reflects the sale/reversal activity *booked in that period* —
 * standard period-based tax accounting. A single past period does NOT retroact
 * a later-period reversal (that reversal is that later period's credit).
 *
 * Coverage (W5a): the order→invoice path (createSplitInvoices) writes SALE rows,
 * and voidInvoice/deleteInvoice reverse them. NOT yet wired (deferred follow-ups,
 * tracked in SESSION-HANDOFF): the manual `create`, `createPartialFromOrder`, the
 * DRAFT `update`, and `reconcileOrderDraftInvoice` paths — a regulated invoice
 * created/edited via those writes no ledger rows today.
 */
@Injectable()
export class RegulatedLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Write one SALE row per REGULATED line (non-regulated lines are skipped).
   * Called from createSplitInvoices right after an invoice + its items exist, so
   * `invoiceItemId` is real. Uses the caller's `db` (tx or base client). Requires
   * a tenantId (the ledger is tenant-scoped and NOT null); skips for the
   * SUPER_ADMIN/no-tenant context, which never generates real sales.
   */
  async writeSaleEntries(params: {
    tenantId: string | null;
    orderId: string | null;
    invoiceId: string;
    soldAt: Date;
    lines: SaleLedgerLine[];
    db: any;
  }): Promise<void> {
    const { tenantId, orderId, invoiceId, soldAt, lines, db } = params;
    if (!tenantId) return;
    const bucket = periodBucketOf(soldAt);
    const rows = lines
      .filter((l) => l.trackedCategoryId)
      .map((l) => ({
        tenantId,
        trackedCategoryId: l.trackedCategoryId as string,
        entryType: "SALE" as const,
        orderId,
        orderItemId: l.orderItemId,
        invoiceId,
        invoiceItemId: l.invoiceItemId,
        qty: l.qty,
        // W5: no unitBasis conversion yet (W3 owns pack/carton math) — passthrough.
        unitBasisQty: l.qty,
        netSales: roundMoney(l.netSales),
        categoryTax: roundMoney(l.categoryTax),
        soldAt,
        periodBucket: bucket,
      }));
    if (rows.length === 0) return;
    await db.regulatedSalesLedger.createMany({ data: rows });
  }

  /**
   * Reverse every SALE row for an invoice (on void/delete): write a negated
   * REVERSAL row per prior SALE, booked into the CURRENT period (standard ledger
   * practice — never backdate). Idempotent: skips lines already reversed, so a
   * double void/delete can't double-reverse. Keyed on `invoiceItemId` (never a
   * join through a possibly-deleted row).
   */
  async reverseInvoiceEntries(params: { invoiceId: string; db: any }): Promise<void> {
    const { invoiceId, db } = params;
    const sales = await db.regulatedSalesLedger.findMany({
      where: { invoiceId, entryType: "SALE" },
    });
    if (sales.length === 0) return;
    const priorReversals = await db.regulatedSalesLedger.findMany({
      where: { invoiceId, entryType: "REVERSAL" },
      select: { invoiceItemId: true },
    });
    const alreadyReversed = new Set(priorReversals.map((r: any) => r.invoiceItemId));
    const now = new Date();
    const bucket = periodBucketOf(now);
    const rows = sales
      .filter((s: any) => !alreadyReversed.has(s.invoiceItemId))
      .map((s: any) => ({
        tenantId: s.tenantId,
        trackedCategoryId: s.trackedCategoryId,
        entryType: "REVERSAL" as const,
        orderId: s.orderId,
        orderItemId: s.orderItemId,
        invoiceId: s.invoiceId,
        invoiceItemId: s.invoiceItemId,
        qty: -Number(s.qty),
        unitBasisQty: -Number(s.unitBasisQty),
        netSales: roundMoney(-Number(s.netSales)),
        categoryTax: roundMoney(-Number(s.categoryTax)),
        soldAt: now,
        periodBucket: bucket,
      }));
    if (rows.length === 0) return;
    await db.regulatedSalesLedger.createMany({ data: rows });
  }

  /**
   * Reverse regulated SALE rows when goods are RETURNED (W5c). A return maps to an
   * ORDER (not an invoice) and carries only productId + qty, so we bridge: SALE
   * rows (by orderId) → InvoiceItem (by invoiceItemId) → productId. Partial returns
   * are PRO-RATED off each SALE row's snapshot (never re-read the live Product
   * category, which may have drifted). Idempotent per `returnId`; qty already
   * reversed on the order (from earlier returns OR an invoice void) is subtracted so
   * cumulative reversed qty can never exceed the sold qty. Reversal books into the
   * CURRENT period. `restock` is a stock concern and is intentionally ignored — a
   * returned regulated sale reverses the ledger even if the goods are scrapped.
   *
   * Known limitation: ReturnItem carries only productId (no order/invoice line id),
   * so returned units are matched to the order's regulated SALE rows for that product
   * (FIFO) and pooled by productId. If one product sits on BOTH a regulated and a
   * non-regulated line of the same order, returning the non-regulated units still
   * reverses the regulated row — the row-remaining cap prevents OVER-reversal, but
   * attribution is approximate. Fixing this needs a ReturnItem→line linkage.
   */
  async reverseReturnEntries(params: {
    returnId: string;
    orderId: string;
    returnedByProduct: Map<string, number>;
    db: any;
  }): Promise<void> {
    const { returnId, orderId, returnedByProduct, db } = params;
    if (!returnedByProduct || returnedByProduct.size === 0) return;

    // Idempotency: this return already reversed → no-op.
    const prior = await db.regulatedSalesLedger.findMany({
      where: { returnId, entryType: "REVERSAL" },
      select: { id: true },
    });
    if (prior.length > 0) return;

    // The order's SALE rows are the snapshot we reverse against.
    const sales = await db.regulatedSalesLedger.findMany({
      where: { orderId, entryType: "SALE" },
    });
    if (sales.length === 0) return;

    // SALE rows carry no productId — recover it via each row's invoice item.
    const invoiceItemIds = [
      ...new Set(sales.map((s: any) => s.invoiceItemId).filter(Boolean)),
    ] as string[];
    const items =
      invoiceItemIds.length > 0
        ? await db.invoiceItem.findMany({
            where: { id: { in: invoiceItemIds } },
            select: { id: true, productId: true },
          })
        : [];
    const productByItem = new Map<string, string>(items.map((i: any) => [i.id, i.productId]));

    // Qty + money already reversed per invoiceItemId (across earlier returns AND
    // invoice voids), so cumulative reversals can never exceed the original sold
    // qty, and the chunk that CLOSES a row can absorb rounding drift (below).
    const priorReversals = await db.regulatedSalesLedger.findMany({
      where: { orderId, entryType: "REVERSAL" },
      select: { invoiceItemId: true, qty: true, netSales: true, categoryTax: true },
    });
    const reversedByItem = new Map<string, number>();
    const netReversedByItem = new Map<string, number>(); // signed (negative)
    const taxReversedByItem = new Map<string, number>();
    for (const r of priorReversals) {
      const k = r.invoiceItemId ?? "";
      reversedByItem.set(k, (reversedByItem.get(k) ?? 0) + -Number(r.qty));
      netReversedByItem.set(k, (netReversedByItem.get(k) ?? 0) + Number(r.netSales));
      taxReversedByItem.set(k, (taxReversedByItem.get(k) ?? 0) + Number(r.categoryTax));
    }

    // SALE rows grouped by product (FIFO within a product).
    const salesByProduct = new Map<string, any[]>();
    for (const s of sales) {
      const pid = productByItem.get(s.invoiceItemId);
      if (!pid) continue;
      if (!salesByProduct.has(pid)) salesByProduct.set(pid, []);
      salesByProduct.get(pid)!.push(s);
    }

    const now = new Date();
    const bucket = periodBucketOf(now);
    const rows: any[] = [];

    for (const [productId, returnedQtyRaw] of returnedByProduct.entries()) {
      let remaining = Number(returnedQtyRaw);
      if (!(remaining > 0)) continue;
      for (const s of salesByProduct.get(productId) ?? []) {
        if (remaining <= 0) break;
        const saleQty = Number(s.qty);
        if (saleQty <= 0) continue;
        const itemKey = s.invoiceItemId ?? "";
        const rowRemaining = saleQty - (reversedByItem.get(itemKey) ?? 0);
        if (rowRemaining <= 0) continue;
        // This chunk CLOSES the row when it consumes all of the remaining qty.
        const closesRow = remaining >= rowRemaining;
        const r = Math.min(remaining, rowRemaining);
        remaining -= r;
        reversedByItem.set(itemKey, (reversedByItem.get(itemKey) ?? 0) + r);
        const frac = r / saleQty; // pro-rate off the ORIGINAL row (no drift)
        // Money: the closing chunk books the EXACT remaining balance (original net
        // minus what's already reversed) so a fully-reversed row nets to 0 across
        // any number of partial returns — no accumulated per-chunk rounding drift.
        // Non-closing chunks book the pro-rated share.
        const netAlready = netReversedByItem.get(itemKey) ?? 0; // signed (negative)
        const taxAlready = taxReversedByItem.get(itemKey) ?? 0;
        rows.push({
          tenantId: s.tenantId,
          trackedCategoryId: s.trackedCategoryId,
          entryType: "REVERSAL" as const,
          orderId: s.orderId,
          orderItemId: s.orderItemId,
          invoiceId: s.invoiceId,
          invoiceItemId: s.invoiceItemId,
          returnId,
          qty: -round3(r),
          unitBasisQty: -round3(Number(s.unitBasisQty) * frac),
          netSales: closesRow
            ? roundMoney(-Number(s.netSales) - netAlready)
            : roundMoney(-Number(s.netSales) * frac),
          categoryTax: closesRow
            ? roundMoney(-Number(s.categoryTax) - taxAlready)
            : roundMoney(-Number(s.categoryTax) * frac),
          soldAt: now,
          periodBucket: bucket,
        });
      }
    }

    if (rows.length === 0) return;
    await db.regulatedSalesLedger.createMany({ data: rows });
  }

  /**
   * Undo a return's REVERSAL rows when the return is CANCELLED before being
   * refunded (symmetric to cancel() deleting the return's stock movements). A
   * delete — not a counter-entry — keeps the `returnId` idempotency guard clean so
   * the order can be legitimately returned again later.
   */
  async unreverseReturnEntries(params: { returnId: string; db: any }): Promise<void> {
    const { returnId, db } = params;
    await db.regulatedSalesLedger.deleteMany({ where: { returnId, entryType: "REVERSAL" } });
  }
}
