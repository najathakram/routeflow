import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { roundMoney } from "../common/pricing";
import { periodBucketOf } from "./period";

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
}
