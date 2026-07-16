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
  // RF-3: reporting-only classification child of the section. Passed through onto the
  // SALE row for the filing breakdown; never affects the regulated filter or any math.
  trackedSubcategoryId?: string | null;
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
 * voidInvoice/deleteInvoice reverse them, and the reconcile paths
 * (reconcileOrderDraftInvoice / reconcileOrderDeliveredInvoices, via
 * InvoicesService#resyncInvoiceLedger) re-sync them to the rebuilt qty by
 * reversing the prior SALE rows and writing fresh ones. STILL NOT wired (deferred):
 * the manual `create` and `createPartialFromOrder` paths — a regulated invoice
 * created via those writes no ledger rows today.
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
        // RF-3: reporting breakdown passthrough (null = section-only). Never gates.
        trackedSubcategoryId: l.trackedSubcategoryId ?? null,
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
   * Reverse an invoice's outstanding regulated SALE (on void/delete, or a reconcile
   * re-sync): write a negated REVERSAL row per line for its REMAINING un-reversed net,
   * booked into the CURRENT period (standard ledger practice — never backdate).
   *
   * NET-AWARE. Each line's remaining = Σ of ALL its signed rows (SALE positive + any
   * existing REVERSAL negative). So a line already partly reversed by a RETURN or credit
   * note reverses only the un-returned remainder (not the full sale, and not skipped
   * entirely) — the earlier "any reversal ⇒ skip" heuristic over-reported a
   * partially-returned sale on void/reconcile. Fully-reversed lines net to ~0 and are
   * skipped, so a double void/delete (or a full prior return) is a no-op. Keyed on
   * `invoiceItemId` (never a join through a possibly-deleted invoice row).
   *
   * `preserveReturns` (reconcile re-sync only): EXCLUDE return / credit-note REVERSALs
   * (those carrying a `returnId`/`creditNoteId`) from each line's remaining, so the
   * re-sync cancels ONLY the sale-record and LEAVES the return's reduction standing. The
   * re-book then nets to (delivered − alreadyReturned), not delivered. Still idempotent:
   * a prior re-sync's own REVERSAL (no returnId/creditNoteId) IS counted, so a repeat
   * re-sync finds 0 remaining and skips. Void/delete leave this false → reverse the full
   * net to 0.
   */
  async reverseInvoiceEntries(params: {
    invoiceId: string;
    db: any;
    preserveReturns?: boolean;
  }): Promise<void> {
    const { invoiceId, db, preserveReturns = false } = params;
    const all = await db.regulatedSalesLedger.findMany({ where: { invoiceId } });
    if (all.length === 0) return;

    // Aggregate the remaining net per invoice line; keep a SALE row for its metadata.
    const byItem = new Map<
      string,
      { sale: any; qty: number; unitBasisQty: number; netSales: number; categoryTax: number }
    >();
    for (const r of all) {
      const key = r.invoiceItemId as string | null;
      if (key == null) continue;
      const cur = byItem.get(key) ?? {
        sale: null,
        qty: 0,
        unitBasisQty: 0,
        netSales: 0,
        categoryTax: 0,
      };
      if (r.entryType === "SALE" && !cur.sale) cur.sale = r;
      // On a preserve-returns re-sync, a return / credit-note reversal is left standing
      // (not counted toward the remaining to reverse) so its reduction survives.
      const isReturnOrCredit =
        r.entryType === "REVERSAL" && (r.returnId != null || r.creditNoteId != null);
      if (!(preserveReturns && isReturnOrCredit)) {
        cur.qty += Number(r.qty);
        cur.unitBasisQty += Number(r.unitBasisQty);
        cur.netSales += Number(r.netSales);
        cur.categoryTax += Number(r.categoryTax);
      }
      byItem.set(key, cur);
    }

    const now = new Date();
    const bucket = periodBucketOf(now);
    const EPS = 0.0005;
    const rows: any[] = [];
    for (const [invoiceItemId, agg] of byItem) {
      if (!agg.sale) continue; // no SALE for this line — nothing of ours to reverse
      // Skip a line whose sale is already fully reversed (net ~0 in every dimension).
      if (
        Math.abs(agg.qty) < EPS &&
        Math.abs(agg.netSales) < EPS &&
        Math.abs(agg.categoryTax) < EPS
      ) {
        continue;
      }
      const s = agg.sale;
      rows.push({
        tenantId: s.tenantId,
        trackedCategoryId: s.trackedCategoryId,
        // RF-3: carry the SALE's reporting breakdown onto the REVERSAL (pure passthrough).
        trackedSubcategoryId: s.trackedSubcategoryId ?? null,
        entryType: "REVERSAL" as const,
        orderId: s.orderId,
        orderItemId: s.orderItemId,
        invoiceId: s.invoiceId,
        invoiceItemId,
        qty: -agg.qty,
        unitBasisQty: -agg.unitBasisQty,
        netSales: roundMoney(-agg.netSales),
        categoryTax: roundMoney(-agg.categoryTax),
        soldAt: now,
        periodBucket: bucket,
      });
    }
    if (rows.length === 0) return;
    await db.regulatedSalesLedger.createMany({ data: rows });
  }

  /**
   * Reverse regulated SALE rows when goods are RETURNED (W5c). A return maps to an
   * ORDER (not an invoice) and carries only productId + qty, so we bridge: SALE
   * rows (by orderId) → InvoiceItem (by invoiceItemId) → productId. Partial returns
   * are PRO-RATED off each SALE row's snapshot (never re-read the live Product
   * category, which may have drifted). Idempotent per `returnId`; everything already
   * reversed on the ORDER LINE (earlier returns, invoice voids, credit notes AND
   * reconcile re-syncs) is subtracted so cumulative reversed qty/net can never exceed
   * the sold amount — and the cap is keyed on `orderItemId` (not the invoice item), so
   * it survives a delivered-basis reconcile that recreates the line under a fresh
   * invoiceItemId. Reversal books into the CURRENT period. `restock` is a stock concern
   * and is intentionally ignored — a returned regulated sale reverses the ledger even
   * if the goods are scrapped.
   *
   * Known limitation: ReturnItem carries only productId (no order/invoice line id),
   * so returned units are matched to the order's regulated SALE rows for that product
   * (FIFO) and pooled by productId. If one product sits on BOTH a regulated and a
   * non-regulated line of the same order, returning the non-regulated units still
   * reverses the regulated row — the per-line remaining cap prevents OVER-reversal, but
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

    // The cumulative-reversal cap is keyed on the ORDER LINE, not the invoice item.
    // A delivered-basis reconcile DELETES an open draft's InvoiceItems and recreates
    // them under fresh ids (rotating invoiceItemId) while re-booking the SALE under
    // the SAME orderItemId. Keying on invoiceItemId would let a 2nd full return after
    // a reconcile read a 0 cap for the new id and over-reverse (category SUM goes
    // negative). orderItemId is stable across recreation; fall back to invoiceItemId
    // for freeform invoice lines (no order line — those never get reconciled).
    const lineKeyOfSale = (s: any): string => s.orderItemId ?? s.invoiceItemId ?? "";
    const orderLineByInvoiceItem = new Map<string, string>();
    for (const s of sales) {
      if (s.invoiceItemId) {
        orderLineByInvoiceItem.set(s.invoiceItemId, s.orderItemId ?? s.invoiceItemId);
      }
    }
    const lineKeyOfReversal = (r: any): string =>
      r.orderItemId ??
      (r.invoiceItemId ? (orderLineByInvoiceItem.get(r.invoiceItemId) ?? r.invoiceItemId) : "");

    // Per-ORDER-LINE remaining un-reversed balance = Σ(SALE) + Σ(REVERSAL, signed)
    // across EVERY row of the line — including rows booked under a now-deleted
    // invoice item before a reconcile. This nets a void to 0, a reconcile to
    // (delivered − alreadyReturned), and a fully returned/credited line to 0, so a
    // return can never drive the category SUM below 0. Seed each line with its total
    // SALE, then fold in every prior REVERSAL (qty/net/tax are stored negative).
    const remQtyByLine = new Map<string, number>();
    const remNetByLine = new Map<string, number>(); // remaining net (>= 0 normally)
    const remTaxByLine = new Map<string, number>();
    for (const s of sales) {
      const lk = lineKeyOfSale(s);
      remQtyByLine.set(lk, (remQtyByLine.get(lk) ?? 0) + Number(s.qty));
      remNetByLine.set(lk, (remNetByLine.get(lk) ?? 0) + Number(s.netSales));
      remTaxByLine.set(lk, (remTaxByLine.get(lk) ?? 0) + Number(s.categoryTax));
    }
    // Everything already reversed on these lines — earlier returns, invoice voids,
    // credit notes AND reconcile re-syncs — folded into the per-line remaining so
    // cumulative reversal can never exceed the sold amount regardless of which path
    // (or which since-rotated invoice item) booked the earlier reversal.
    const priorReversals = await db.regulatedSalesLedger.findMany({
      where: { invoiceItemId: { in: invoiceItemIds }, entryType: "REVERSAL" },
      select: {
        invoiceItemId: true,
        orderItemId: true,
        qty: true,
        netSales: true,
        categoryTax: true,
      },
    });
    for (const r of priorReversals) {
      const lk = lineKeyOfReversal(r);
      remQtyByLine.set(lk, (remQtyByLine.get(lk) ?? 0) + Number(r.qty)); // r.qty <= 0
      remNetByLine.set(lk, (remNetByLine.get(lk) ?? 0) + Number(r.netSales));
      remTaxByLine.set(lk, (remTaxByLine.get(lk) ?? 0) + Number(r.categoryTax));
    }

    // SALE rows grouped by product (FIFO within a product). Only LIVE sale rows
    // (invoice item still present) are reversal targets; the per-line remaining
    // above already accounts for the pre-reconcile rows on the deleted items.
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
        const lk = lineKeyOfSale(s);
        // Cap this chunk at the ORDER LINE's remaining un-reversed qty (survives a
        // reconcile that rotated the invoice item), not just this row's own qty.
        const rowRemaining = remQtyByLine.get(lk) ?? 0;
        if (rowRemaining <= 0) continue;
        // This chunk CLOSES the line when it consumes all of its remaining qty.
        const closesRow = remaining >= rowRemaining;
        const r = Math.min(remaining, rowRemaining);
        remaining -= r;
        const frac = r / saleQty; // pro-rate off the LIVE row's per-unit snapshot
        const netRem = remNetByLine.get(lk) ?? 0; // remaining line net (>= 0)
        const taxRem = remTaxByLine.get(lk) ?? 0;
        // Money: the chunk that CLOSES the line books its EXACT remaining balance so a
        // fully-reversed line nets to 0 across any number of partial returns. A
        // non-closing chunk books the pro-rated share, but clamped to the line's
        // remaining — the LIVE row's per-unit can exceed the remaining per-unit after a
        // reconcile RE-PRICED the line (old rows folded in at a different price), and a
        // fractional partial just under the full remaining qty could otherwise
        // over-reverse the net/tax dimensions past 0.
        let bookedNet = closesRow ? roundMoney(-netRem) : roundMoney(-Number(s.netSales) * frac);
        let bookedTax = closesRow ? roundMoney(-taxRem) : roundMoney(-Number(s.categoryTax) * frac);
        if (bookedNet < -netRem) bookedNet = roundMoney(-netRem);
        if (bookedTax < -taxRem) bookedTax = roundMoney(-taxRem);
        remQtyByLine.set(lk, rowRemaining - r);
        remNetByLine.set(lk, netRem + bookedNet);
        remTaxByLine.set(lk, taxRem + bookedTax);
        rows.push({
          tenantId: s.tenantId,
          trackedCategoryId: s.trackedCategoryId,
          // RF-3: carry the SALE's reporting breakdown onto the REVERSAL (pure passthrough).
          trackedSubcategoryId: s.trackedSubcategoryId ?? null,
          entryType: "REVERSAL" as const,
          orderId: s.orderId,
          orderItemId: s.orderItemId,
          invoiceId: s.invoiceId,
          invoiceItemId: s.invoiceItemId,
          returnId,
          qty: -round3(r),
          unitBasisQty: -round3(Number(s.unitBasisQty) * frac),
          netSales: bookedNet,
          categoryTax: bookedTax,
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

  /**
   * Reverse regulated SALE rows when a CREDIT NOTE is issued (W5c). Unlike a return,
   * a credit note carries no goods — so the per-category breakdown comes from its
   * CreditNoteItems, which credit-notes.service builds ONLY for the invoice lines the
   * operator explicitly credited (line linkage), snapshotting each line's category as
   * it was AT SALE. Safety invariants (each independently regression-tested):
   *  - SALE-existence: a REVERSAL is booked ONLY against a line that actually recorded
   *    a regulated SALE — never "naked" (pre-W5 / non-split invoices have no SALE rows).
   *  - Over-reversal clamp: cumulative reversed net/qty per ORDER LINE can never exceed
   *    the SALE's remaining un-reversed balance, counting credit-note, return, void AND
   *    reconcile re-sync reversals together (keyed by orderItemId so it survives a
   *    reconcile that recreates the line under a fresh invoiceItemId), so
   *    credit-then-return — or a 2nd credit after a reconcile — can't double-reverse.
   *  - Closing balance: the credit that CLOSES a line books the EXACT remaining balance
   *    (not the independently-rounded share), so a fully-credited line nets to exactly 0
   *    across any number of partial credits.
   * REVERSAL rows carry the SALE's orderId/orderItemId/invoiceId so every reversal path
   * reconciles. Idempotent per `creditNoteId`. Books into the CURRENT period.
   */
  async reverseCreditNoteEntries(params: { creditNoteId: string; db: any }): Promise<void> {
    const { creditNoteId, db } = params;

    // Idempotency: this credit note already reversed → no-op.
    const prior = await db.regulatedSalesLedger.findMany({
      where: { creditNoteId, entryType: "REVERSAL" },
      select: { id: true },
    });
    if (prior.length > 0) return;

    const items = await db.creditNoteItem.findMany({
      where: { creditNoteId, trackedCategoryId: { not: null } },
    });
    if (items.length === 0) return;

    const invoiceItemIds = [
      ...new Set(items.map((it: any) => it.invoiceItemId).filter(Boolean)),
    ] as string[];
    if (invoiceItemIds.length === 0) return;

    // The credited lines' LIVE SALE rows — the source ids stamped onto reversals and
    // the SALE-existence guard (only a line that recorded a live regulated SALE can be
    // credited). Keyed by the credited invoice item.
    const liveSaleRows = await db.regulatedSalesLedger.findMany({
      where: { invoiceItemId: { in: invoiceItemIds }, entryType: "SALE" },
      select: {
        invoiceItemId: true,
        netSales: true,
        orderId: true,
        orderItemId: true,
        invoiceId: true,
        // RF-3: reporting breakdown carried onto the REVERSAL rows below.
        trackedSubcategoryId: true,
      },
    });
    const liveSaleByItem = new Map<
      string,
      {
        net: number;
        orderId: string | null;
        orderItemId: string | null;
        invoiceId: string | null;
        trackedSubcategoryId: string | null;
      }
    >();
    for (const s of liveSaleRows) {
      const k = s.invoiceItemId ?? "";
      const cur = liveSaleByItem.get(k) ?? {
        net: 0,
        orderId: s.orderId ?? null,
        orderItemId: s.orderItemId ?? null,
        invoiceId: s.invoiceId ?? null,
        trackedSubcategoryId: s.trackedSubcategoryId ?? null,
      };
      cur.net += Number(s.netSales);
      liveSaleByItem.set(k, cur);
    }

    // The cumulative-reversal cap is keyed on the ORDER LINE, not the invoice item.
    // A delivered-basis reconcile DELETES an open draft's InvoiceItems and recreates
    // them under fresh ids (rotating invoiceItemId) while re-booking the SALE under
    // the SAME orderItemId. Keying on invoiceItemId would let a 2nd full credit after
    // a reconcile read a 0 cap for the new id and over-reverse (category SUM goes
    // negative). orderItemId is stable; fall back to invoiceItemId for freeform lines
    // (no order line — never reconciled). Pull EVERY SALE/REVERSAL row of the credited
    // order lines (incl. rows booked under a now-deleted invoice item pre-reconcile).
    const orderLineIds = [
      ...new Set(liveSaleRows.map((s: any) => s.orderItemId).filter(Boolean)),
    ] as string[];
    const lineRows = await db.regulatedSalesLedger.findMany({
      where: {
        entryType: { in: ["SALE", "REVERSAL"] },
        OR: [
          ...(orderLineIds.length > 0 ? [{ orderItemId: { in: orderLineIds } }] : []),
          { invoiceItemId: { in: invoiceItemIds } },
        ],
      },
      select: {
        entryType: true,
        invoiceItemId: true,
        orderItemId: true,
        netSales: true,
        qty: true,
        categoryTax: true,
      },
    });
    // invoiceItemId → order line, so legacy REVERSAL rows with a null orderItemId can
    // still be attributed to their line (bridge through a matching SALE row).
    const orderLineByInvoiceItem = new Map<string, string>();
    for (const r of lineRows) {
      if (r.entryType === "SALE" && r.invoiceItemId) {
        orderLineByInvoiceItem.set(r.invoiceItemId, r.orderItemId ?? r.invoiceItemId);
      }
    }
    const lineKeyOf = (r: any): string =>
      r.orderItemId ??
      (r.invoiceItemId ? (orderLineByInvoiceItem.get(r.invoiceItemId) ?? r.invoiceItemId) : "");

    // Per-ORDER-LINE totals: SALE (positive) and everything already reversed —
    // credit-note, return, void AND reconcile re-sync reversals (signed negative) —
    // so cumulative reversal can never exceed the sold amount no matter which path or
    // since-rotated invoice item booked the earlier reversal.
    const saleByLine = new Map<string, { net: number; qty: number; tax: number }>();
    const revByLine = new Map<string, { net: number; qty: number; tax: number }>();
    for (const r of lineRows) {
      const lk = lineKeyOf(r);
      const bag = r.entryType === "SALE" ? saleByLine : revByLine;
      const cur = bag.get(lk) ?? { net: 0, qty: 0, tax: 0 };
      cur.net += Number(r.netSales);
      cur.qty += Number(r.qty);
      cur.tax += Number(r.categoryTax);
      bag.set(lk, cur);
    }

    const now = new Date();
    const bucket = periodBucketOf(now);
    const rows: any[] = [];
    for (const it of items) {
      const live = liveSaleByItem.get(it.invoiceItemId ?? "");
      if (!live || live.net <= 0) continue; // SALE-existence guard — no naked reversal.
      const lk = live.orderItemId ?? it.invoiceItemId ?? "";
      const sale = saleByLine.get(lk) ?? { net: 0, qty: 0, tax: 0 };
      if (sale.net <= 0) continue;
      const already = revByLine.get(lk) ?? { net: 0, qty: 0, tax: 0 };
      // Remaining capacity to reverse for the ORDER LINE (signed, negative). `sale.*`
      // is the line's gross SALE, `already.*` (<= 0) folds in the reconcile re-sync
      // reversals that offset the pre-reconcile SALE rows, so this nets to the current
      // un-reversed balance.
      const remNet = -sale.net - already.net;
      const remQty = -sale.qty - already.qty;
      const remTax = -sale.tax - already.tax;
      if (remNet >= -0.005) continue; // line already fully reversed — nothing left.

      let net = -Number(it.amount);
      let qty = -Number(it.qty);
      let tax = -Number(it.categoryTax);
      // CLOSES when this credit reaches/overshoots the remaining balance: book the
      // EXACT remaining (absorbs multi-credit rounding drift AND clamps over-reversal).
      const closes = net <= remNet + 0.005;
      if (closes) {
        net = remNet;
        qty = remQty;
        tax = remTax;
      } else {
        // Partial credit: clamp defensively so no dimension can exceed the remaining.
        if (qty < remQty) qty = remQty;
        if (tax < remTax) tax = remTax;
      }
      const bookedNet = roundMoney(net);
      const bookedQty = round3(qty);
      const bookedTax = roundMoney(tax);
      rows.push({
        tenantId: it.tenantId,
        trackedCategoryId: it.trackedCategoryId,
        // RF-3: carry the SALE's reporting breakdown onto the REVERSAL (pure passthrough).
        trackedSubcategoryId: live.trackedSubcategoryId ?? null,
        entryType: "REVERSAL" as const,
        orderId: live.orderId,
        orderItemId: live.orderItemId,
        invoiceId: live.invoiceId,
        invoiceItemId: it.invoiceItemId,
        creditNoteId,
        qty: bookedQty,
        unitBasisQty: bookedQty,
        netSales: bookedNet,
        categoryTax: bookedTax,
        soldAt: now,
        periodBucket: bucket,
      });
      // Accumulate onto the ORDER LINE so a second CreditNoteItem on the same line
      // (within this credit note) sees the reduced remaining and can't re-consume.
      revByLine.set(lk, {
        net: already.net + bookedNet,
        qty: already.qty + bookedQty,
        tax: already.tax + bookedTax,
      });
    }
    if (rows.length === 0) return;
    await db.regulatedSalesLedger.createMany({ data: rows });
  }

  /** Undo a credit note's REVERSAL rows when the credit note is VOIDED (symmetric
   *  to the returns cancel-undo). Delete keeps the `creditNoteId` idempotency clean. */
  async unreverseCreditNoteEntries(params: { creditNoteId: string; db: any }): Promise<void> {
    const { creditNoteId, db } = params;
    await db.regulatedSalesLedger.deleteMany({ where: { creditNoteId, entryType: "REVERSAL" } });
  }
}
