import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  creditedThrough,
  roundMoney,
  regulatedUnitBasis,
  classifySaleAxis,
  type SaleAxisLine,
  type SaleAxisCorrection,
  type SaleAxisState,
} from "@routeflow/pricing";
import { periodBucketOf } from "./period";
import { resolveSaleLines, type ResolvedSaleLine } from "./sale-line-resolver";
import { unbookedReversalMeta } from "./unbooked-reversals";
import { writeAdminNotice } from "../billing/manual-invoice-notice";
import { AdminAuditAction } from "../platform-admin/audit-actions.constant";

/** Round a quantity to 3 decimals (matches the Decimal(12,3) ledger columns). */
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * One regulated invoice line, as seen at invoice-creation time. B661: the caller passes the
 * line's own STORED SHAPE (never a pre-computed unit basis — see `writeSaleEntries`, which is
 * the ONLY place `unitBasisQty` is derived, via `regulatedUnitBasis`). `qty` stays the line's own
 * qty — it becomes the ledger row's `qty`, which reconciles to the invoice line — and is no
 * longer read as an input to the row's `unitBasisQty`.
 */
/**
 * The fields `resolveParkedReversal` (SA-089a) supplies to `regulatedSalesLedger.create` for a
 * correction row (SALE-typed, restating a sale's basis, or REVERSAL-typed, restating an earlier
 * box-axis reversal) or a freshly-booked REVERSAL row from `bookReversalChunk`. Narrower than
 * the full Prisma input type (this method never sets every column), but enough to keep `rows`
 * and each correction object out of `any`.
 */
interface RegulatedCorrectionRowInput {
  tenantId: string;
  trackedCategoryId: string | null;
  trackedSubcategoryId: string | null;
  entryType: "SALE" | "REVERSAL";
  orderId: string | null;
  orderItemId: string | null;
  invoiceId: string | null;
  invoiceItemId: string | null;
  correctsEntryId: string;
  originalSoldAt: Date;
  soldAt: Date;
  qty: number;
  unitBasisQty: number;
  netSales: number;
  categoryTax: number;
  periodBucket: string;
  returnId?: string;
}

/** #2108: a filed (GENERATED or LOCKED) filing period a parked reversal would otherwise book into, and
 *  the category whose filing matched. */
export interface FiledPeriod {
  periodKey: string;
  status: string;
  trackedCategoryId: string;
}

export interface SaleLedgerLine {
  invoiceItemId: string;
  orderItemId: string | null;
  trackedCategoryId: string | null;
  // RF-3: reporting-only classification child of the section. Passed through onto the
  // SALE row for the filing breakdown; never affects the regulated filter or any math.
  trackedSubcategoryId?: string | null;
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  unitLabel?: string | null;
  /** The product's `unitsPerBox` AS SNAPSHOT at this write — never a later re-read. See
   * `regulatedUnitBasis`'s box-unaware fallback (branch 4). */
  packAtSale?: number | null;
  netSales: number; // the line's post-discount subtotal
  categoryTax: number; // computed category tax (0 today — tobacco is rate=0)
}

/** One re-priced regulated invoice line, as `correctSaleForPriceChange` needs it (B662). */
export interface PriceCorrectionLine {
  invoiceItemId: string;
  qty: number; // the line's qty (its own unit, the same axis as the SALE rows)
  netSales: number; // the line's NEW post-discount subtotal
  categoryTax: number; // the line's NEW category tax
  boxes?: number | null;
  unitsPerBox?: number | null;
  promoFreeUnits?: number | null; // BUY_N_GET_M snapshot, in whole selling units
}

/**
 * B662, the single branch point for "what does a price change do after a partial return?" (Senior
 * Architect ruling 2026-09-21: remainder only, computed as a TARGET). The new figure is prorated to the
 * qty still held in the ledger through the pricing package's proration helper (which knows about free
 * units); the delta is target minus the net held. A TARGET is idempotent and free of rounding drift.
 */
export function priceCorrectionTarget(
  newAmount: number,
  remainingQty: number,
  line: Pick<PriceCorrectionLine, "qty">,
): number {
  // B894 (SA-576): LINEAR, the same slice rule as a return credit (priceMatchedChunk), so booked − returned
  // credits nets to the target. The invoice's free-unit telescope is non-monotone and not additive.
  return creditedThrough(newAmount, remainingQty, line.qty);
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
 * reversing the prior SALE rows and writing fresh ones. RF-1: the manual `create`
 * path now writes SALE rows too (orderId null) and the DRAFT `update` path re-syncs
 * them. STILL NOT wired (deferred): `createPartialFromOrder` — a regulated PARTIAL
 * invoice writes no ledger rows until a later delivered-basis reconcile rewrites it.
 */
@Injectable()
export class RegulatedLedgerService {
  private readonly logger = new Logger(RegulatedLedgerService.name);

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
      .map((l) => {
        // B661: the ONE place a SALE row's unitBasisQty is derived — from the line's own
        // stored shape and its write-time pack snapshot, never a caller-supplied number.
        const { unitBasisQty, warn } = regulatedUnitBasis(l, l.packAtSale);
        if (warn) {
          this.logger.warn(
            `writeSaleEntries: invoiceItemId ${l.invoiceItemId} (orderItemId ${l.orderItemId}) — ${warn}`,
          );
        }
        return {
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
          unitBasisQty,
          netSales: roundMoney(l.netSales),
          categoryTax: roundMoney(l.categoryTax),
          soldAt,
          periodBucket: bucket,
        };
      });
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
      //
      // `unitBasisQty` is one of those dimensions. Since B661 it is a PIECE count while `qty` is in the
      // line's own unit, so a line can be square on money, qty and tax while still carrying a piece
      // residue — every row a pre-fix credit note wrote against a box-unaware line is exactly that shape.
      // Leaving it out of this guard is what made those rows permanent: a later void read the line as
      // already reversed and never cleared the phantom pieces off the filing. Including it means the void
      // books a row that is zero in money and non-zero only on the axis that is actually outstanding.
      if (
        Math.abs(agg.qty) < EPS &&
        Math.abs(agg.unitBasisQty) < EPS &&
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
        // round3 like every other quantity writer: these are Decimal(12,3) columns and an unrounded
        // float sum lands as e.g. -39.995999999999995 (Postgres rounds it, but no other writer relies
        // on that).
        qty: -round3(agg.qty),
        unitBasisQty: -round3(agg.unitBasisQty),
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
   * category, which may have drifted). Idempotent per `(returnId, orderId)` (PR-1a —
   * widened from `returnId` alone so an INLINE return spanning multiple source orders
   * reverses each independently; a STANDARD return has exactly one source order, so
   * this is unchanged for it).
   *
   * `returnedUnit` (live production regression, B661/B671 fix, round 2): `returnedByProduct`
   * arrives in a DIFFERENT unit per caller, and the caller must say which — never inferred.
   * `returns.service.ts`'s standard `receive()` sums raw `ReturnItem.qty`, which mirrors
   * `OrderItem.qty` (`returns-pieces.util.ts` converts to pieces only for the over-return cap, never on disk) — the LINE's OWN unit, boxes for a box-unaware line, never pieces despite that
   * file's header comment. `inline-returns.service.ts`'s `capture()` builds `ReturnItem.qty`
   * from `priced.chunks[].pieces` — genuinely PIECES. B671 made `unitBasisQty` (pieces) the
   * cap/closing/pro-rata axis unconditionally, which is correct for the inline (PIECES) caller
   * but silently compared boxes against pieces for the standard (LINE_UNIT) caller: a
   * box-unaware sale of 5 boxes at pack 12 fully returned computed `closesRow = 5 >= 60` as
   * false and `frac = 5/60`, reversing ~8% of the sale instead of all of it. `returnedUnit`
   * selects which axis (`remQtyByLine`/`s.qty` for LINE_UNIT, `remUnitBasisByLine`/
   * `s.unitBasisQty` for PIECES — both already seeded below) caps/closes/pro-rates off; the
   * OTHER axis is then derived proportionally by the same fraction, never independently
   * clamped-and-rounded the way the native axis is (that would re-admit drift the closing rule
   * exists to prevent). Everything already
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

  /**
   * SA-789 F1 (row 558): every ledger row -> line resolution goes through `resolveSaleLines`
   * (`./sale-line-resolver`): invoice item first, then the stable order line. This returns the
   * invoice-item -> product bridge the walks key on, filled for a row whose invoice item was
   * re-created too (the stale id maps to the product its order line resolves to).
   */
  private static async productsByInvoiceItem(
    db: any,
    sales: Array<{ id: string; invoiceItemId: string | null; orderItemId: string | null }>,
  ): Promise<{
    productByItem: Map<string, string>;
    resolved: Map<string, ResolvedSaleLine>;
  }> {
    const resolved = await resolveSaleLines(db, sales);
    // SA-835 MUST-1: an order line that still has a row on a LIVE invoice item is booked against that
    // row only. An earlier generation (already offset by a delivered-basis resync) resolves through the
    // order line too, but must never become a reversal target: it would be booked first (oldest first)
    // under the wrong invoice item / ratio. A stale row is a target only when its line has no live row.
    const liveOrderLines = new Set<string>();
    for (const s of sales) {
      if (s.orderItemId && resolved.get(s.id)?.liveInvoiceItemId) liveOrderLines.add(s.orderItemId);
    }
    const productByItem = new Map<string, string>();
    for (const s of sales) {
      const r = resolved.get(s.id);
      if (r?.viaOrderItem && s.orderItemId && liveOrderLines.has(s.orderItemId)) continue;
      if (s.invoiceItemId && r?.productId) productByItem.set(s.invoiceItemId, r.productId);
    }
    return { productByItem, resolved };
  }

  /** Prior correction rows for these SALE row ids (correctsEntryId -> its deltas), for
   *  `classifySaleAxis`'s idempotency fold (SA-070(a)) — a row this routine already corrected
   *  reads piece-axis from then on and is never re-parked. */
  private async loadCorrectionsBySaleId(
    db: any,
    saleIds: string[],
  ): Promise<Map<string, SaleAxisCorrection[]>> {
    if (saleIds.length === 0) return new Map();
    const corrections = await db.regulatedSalesLedger.findMany({
      where: { correctsEntryId: { in: saleIds } },
      select: { correctsEntryId: true, qty: true, unitBasisQty: true },
    });
    const out = new Map<string, SaleAxisCorrection[]>();
    for (const c of corrections) {
      const key = c.correctsEntryId as string;
      const list = out.get(key) ?? [];
      list.push({ qty: c.qty, unitBasisQty: c.unitBasisQty });
      out.set(key, list);
    }
    return out;
  }

  /** The live `Product.unitsPerBox` for these product ids — `classifySaleAxis`'s boxed-gate
   *  fallback (SA-038: a GATE, never a multiplier) when a line carries no pack snapshot of its
   *  own. `undefined` (key absent) when the product itself can't be found — distinct from an
   *  explicit `null`, which `classifySaleAxis` reads as "product exists, not boxed". */
  private async loadProductPackNow(
    db: any,
    productIds: string[],
  ): Promise<Map<string, number | null>> {
    if (productIds.length === 0) return new Map();
    const products = await db.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, unitsPerBox: true },
    });
    return new Map(products.map((p: any) => [p.id, p.unitsPerBox]));
  }

  /**
   * SA-789 F1: a reversal the ledger could NOT book (its sold line resolves nowhere) is made visible,
   * never skipped: `logger.error` plus an in-app notice for support. The return / credit note itself
   * still goes through (no new refusal for operators). Ids only, no names.
   */
  private async reportUnbookedReversal(
    db: any,
    n: { tenantId: string; message: string; meta: Record<string, unknown> },
  ): Promise<void> {
    // One notice per (return | credit note, sale entry): a retried call must not write it again.
    const field = n.meta.returnId ? "returnId" : "creditNoteId";
    const already = await db.auditLog.findFirst({
      where: {
        tenantId: n.tenantId,
        action: AdminAuditAction.REGULATED_REVERSAL_UNBOOKED,
        AND: [
          { meta: { path: [field], equals: n.meta[field] } },
          { meta: { path: ["saleEntryId"], equals: n.meta.saleEntryId } },
        ],
      },
      select: { id: true },
    });
    if (already) return;
    this.logger.error(`regulated reversal unbooked: ${JSON.stringify(n.meta)}`);
    await writeAdminNotice(db, {
      tenantId: n.tenantId,
      action: AdminAuditAction.REGULATED_REVERSAL_UNBOOKED,
      message: n.message,
      meta: n.meta,
    });
  }

  /**
   * SA-067(3): one row in `RegulatedLedgerParkedReversal` per (returnId, saleEntryId) —
   * idempotent via `createMany skipDuplicates` against the table's own unique constraint, so a
   * retried call parks the same row once. Naming: "parked" here names THIS db row; the B681
   * correction routine also says "parked" for a line it classifies unknown-basis and refuses to
   * touch — a different thing at a different layer. The two meanings must never be conflated in
   * code, logs or comments.
   */
  private async parkReturnReversal(
    db: any,
    row: {
      tenantId: string;
      returnId: string;
      orderId: string;
      orderItemId: string | null;
      saleEntryId: string;
      returnedPieces: number;
      reason: string;
      periodBucket: string;
      /** Only the resolution's resumed walk sets this (SA-182): a row it parks inherits the return's date. */
      createdAt?: Date;
    },
  ): Promise<void> {
    await db.regulatedLedgerParkedReversal.createMany({ data: [row], skipDuplicates: true });
    this.logger.warn(
      `B681 park guard: parked a return reversal (returnId=${row.returnId}, ` +
        `saleEntryId=${row.saleEntryId}, reason="${row.reason}") — the sold line's box/piece axis ` +
        `could not be classified; nothing booked, the return/restock/credit proceed untouched.`,
    );
  }

  /**
   * B660a — pure extraction from `reverseReturnEntries`'s inner loop, zero behavior change:
   * classify ONE sale row's box/piece axis, park it if unclassifiable, or cap/pro-rate it
   * against its order line's remaining balance and push a REVERSAL row onto `params.rows`.
   * Split out so a future parked-reversal RESOLUTION path (B660) can book a single row through
   * the exact same money math, rather than a second copy of it — mutates
   * remQtyByLine/remUnitBasisByLine/remNetByLine/remTaxByLine in place (the caller's own Map
   * instances) exactly as the inline code did; returns the updated `remaining` for the product
   * and whether this row parked (the caller `break`s on true, matching the original `break`).
   */
  private async bookReversalChunk(params: {
    db: any;
    s: any;
    remaining: number;
    returnId: string;
    orderId: string;
    returnedUnit: "LINE_UNIT" | "PIECES";
    bucket: string;
    now: Date;
    lineKeyOfSale: (s: any) => string;
    nativeRemByLine: Map<string, number>;
    remQtyByLine: Map<string, number>;
    remUnitBasisByLine: Map<string, number>;
    remNetByLine: Map<string, number>;
    remTaxByLine: Map<string, number>;
    lineShapeBySaleId: Map<string, { line: SaleAxisLine | null; productId: string | null }>;
    correctionsBySaleId: Map<string, SaleAxisCorrection[]>;
    packNowByProduct: Map<string, number | null>;
    rows: any[];
    /** SA-182 (resolution only): the return's date, stamped on a row this call parks. */
    parkDate?: Date;
    /** SA-193 (resolution only): the period a row this call parks belongs to (always the ORIGINAL
     *  park's month, even when the reversal itself books in the current period). */
    parkBucket?: string;
    /** SA-182 (resolution only, parked period already filed): the return's date as `originalSoldAt`. */
    originalSoldAt?: Date;
    /** SA-193 (resolution only): how to park a leftover. The resumed walk never mints onto an existing
     *  key (no skipDuplicates): it grows an unresolved park or creates a new one. */
    parkOverride?: (row: {
      tenantId: string;
      returnId: string;
      orderId: string;
      orderItemId: string | null;
      saleEntryId: string;
      returnedPieces: number;
      reason: string;
      periodBucket: string;
      createdAt?: Date;
    }) => Promise<void>;
    /** SA-193 (resolution only): sale rows whose park THIS return already resolved -> the operator's
     *  attested pack. Such a row is never re-parked (or re-opened): it books against its remaining. */
    attestedPackBySaleId?: Map<string, number>;
  }): Promise<{ remaining: number; parked: boolean }> {
    const {
      db,
      s,
      returnId,
      orderId,
      returnedUnit,
      bucket,
      now,
      lineKeyOfSale,
      nativeRemByLine,
      remQtyByLine,
      remUnitBasisByLine,
      remNetByLine,
      remTaxByLine,
      lineShapeBySaleId,
      correctionsBySaleId,
      packNowByProduct,
      rows,
    } = params;
    let remaining = params.remaining;

    const saleQty = Number(s.qty);
    let saleUnitBasis = Number(s.unitBasisQty);

    // B681/SA-067: PIECES branch only — the LINE_UNIT branch compares boxes to boxes
    // correctly on a box-unaware row and must not park it. Before capping: can this SALE
    // row's box/piece axis even be trusted? A box-unaware line (no stored split, no unit)
    // that books unitBasisQty == qty is indistinguishable from "recorded in box units,
    // never expanded to pieces" (the pre-B661 defect) UNLESS something else (a split, a
    // unit label, or the product simply not being boxed) already explains it —
    // `classifySaleAxis` is the one shared answer, folding in this row's own prior
    // corrections so an already-corrected row is never re-parked.
    const ownCorrections = correctionsBySaleId.get(s.id) ?? [];
    if (returnedUnit === "PIECES") {
      const shape = lineShapeBySaleId.get(s.id) ?? { line: null, productId: null };
      const productPackNow = shape.productId ? packNowByProduct.get(shape.productId) : undefined;
      const verdict = classifySaleAxis(
        {
          entryType: s.entryType,
          qty: s.qty,
          unitBasisQty: s.unitBasisQty,
          writtenAt: s.createdAt ?? null,
        },
        shape.line,
        ownCorrections,
        productPackNow,
      );
      // SA-193: a row whose park this return already RESOLVED carries the operator's attestation as its
      // axis (pack 1 = piece-axis, pack > 1 = fixed by its corrections): it books, never re-parks.
      const attested = params.attestedPackBySaleId?.has(s.id) ?? false;
      if (!attested && (verdict.state === "legacy" || verdict.state === "unknown")) {
        const parkRow = {
          tenantId: s.tenantId,
          returnId,
          orderId: s.orderId ?? orderId,
          orderItemId: s.orderItemId ?? null,
          saleEntryId: s.id,
          returnedPieces: remaining,
          reason: verdict.reason,
          periodBucket: params.parkBucket ?? bucket,
          ...(params.parkDate ? { createdAt: params.parkDate } : {}),
        };
        if (params.parkOverride) await params.parkOverride(parkRow);
        else await this.parkReturnReversal(db, parkRow);
        return { remaining: 0, parked: true };
      }
      // SA-070(b) Hazard 1 continued: excluding a correction row from `salesByProduct` stops
      // it being consumed as its own fake sale, but the ORIGINAL row it corrects must still
      // pro-rate against its TRUE current unit basis (this row's own stored figure plus every
      // correction pointing at it), not the stale stored figure alone — otherwise a corrected
      // row's `frac` is computed against a denominator smaller than what the line's remaining
      // map (which DOES fold corrections in) already reflects, over-booking money and
      // under-booking pieces relative to the actual remaining balance.
      for (const c of ownCorrections) {
        const d = Number(c.unitBasisQty);
        if (Number.isFinite(d)) saleUnitBasis += d;
      }
    }
    const saleNativeAxis = returnedUnit === "PIECES" ? saleUnitBasis : saleQty;
    if (saleNativeAxis <= 0) return { remaining, parked: false };

    const lk = lineKeyOfSale(s);
    // Cap this chunk at the ORDER LINE's remaining un-reversed amount ON THE CALLER'S OWN
    // AXIS (survives a reconcile that rotated the invoice item), not the other axis — B671:
    // comparing pieces against a box-unaware line's box count (or vice versa) silently
    // closed the whole line on a fractional return, or reversed only a sliver of a full one.
    const rowRemainingNative = nativeRemByLine.get(lk) ?? 0;
    if (rowRemainingNative <= 0) return { remaining, parked: false };
    // This chunk CLOSES the line when it consumes all of its remaining native-axis amount.
    const closesRow = remaining >= rowRemainingNative;
    const rNative = Math.min(remaining, rowRemainingNative);
    remaining -= rNative;
    const frac = rNative / saleNativeAxis; // pro-rate off the LIVE row's own native axis
    const rowRemainingQty = remQtyByLine.get(lk) ?? 0; // the line's OWN unit (boxes, etc.)
    const rowRemainingUnitBasis = remUnitBasisByLine.get(lk) ?? 0; // pieces
    const netRem = remNetByLine.get(lk) ?? 0; // remaining line net (>= 0)
    const taxRem = remTaxByLine.get(lk) ?? 0;
    // Money: the chunk that CLOSES the line books its EXACT remaining balance so a
    // fully-reversed line nets to 0 across any number of partial returns. A
    // non-closing chunk books the pro-rated share, but clamped to the line's
    // remaining — the LIVE row's per-unit can exceed the remaining per-unit after a
    // reconcile RE-PRICED the line (old rows folded in at a different price), and a
    // fractional partial just under the full remaining qty could otherwise
    // over-reverse the net/tax dimensions past 0.
    // B662: a non-closing chunk takes its share of what the line STILL HOLDS (remaining net/tax over
    // the remaining native qty), not of the base sale: exact in any order of partial returns and price
    // corrections, on both axes, and independent of whether the caller loaded the correction map (a
    // STANDARD return is LINE_UNIT and does not). A $240 sale corrected to $300, 12 of 72 back = -$50.
    let bookedNet = closesRow
      ? roundMoney(-netRem)
      : roundMoney((-netRem * rNative) / rowRemainingNative);
    let bookedTax = closesRow
      ? roundMoney(-taxRem)
      : roundMoney((-taxRem * rNative) / rowRemainingNative);
    if (bookedNet < -netRem) bookedNet = roundMoney(-netRem);
    if (bookedTax < -taxRem) bookedTax = roundMoney(-taxRem);
    // The NATIVE axis is exactly rNative (never re-derived through frac — that would
    // re-admit the rounding drift the closing rule exists to prevent). The OTHER axis is
    // derived by the same frac, clamped to ITS OWN remaining the same way net/tax are.
    let bookedQty: number;
    let bookedUnitBasis: number;
    if (returnedUnit === "PIECES") {
      bookedUnitBasis = closesRow ? rowRemainingUnitBasis : rNative;
      if (bookedUnitBasis > rowRemainingUnitBasis) bookedUnitBasis = rowRemainingUnitBasis;
      bookedQty = closesRow ? rowRemainingQty : round3(saleQty * frac);
      if (bookedQty > rowRemainingQty) bookedQty = rowRemainingQty;
    } else {
      bookedQty = closesRow ? rowRemainingQty : rNative;
      if (bookedQty > rowRemainingQty) bookedQty = rowRemainingQty;
      bookedUnitBasis = closesRow ? rowRemainingUnitBasis : round3(saleUnitBasis * frac);
      if (bookedUnitBasis > rowRemainingUnitBasis) bookedUnitBasis = rowRemainingUnitBasis;
    }
    remQtyByLine.set(lk, rowRemainingQty - bookedQty);
    remUnitBasisByLine.set(lk, rowRemainingUnitBasis - bookedUnitBasis);
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
      qty: -round3(bookedQty),
      unitBasisQty: -round3(bookedUnitBasis),
      netSales: bookedNet,
      categoryTax: bookedTax,
      soldAt: now,
      periodBucket: bucket,
      ...(params.originalSoldAt ? { originalSoldAt: params.originalSoldAt } : {}),
    });
    return { remaining, parked: false };
  }

  /**
   * B660a — pure extraction from `reverseReturnEntries`, zero behavior change: the order's SALE
   * rows, their product lookup, the line-keying (survives a reconcile's invoice-item rotation),
   * and each order line's remaining un-reversed balance (Σ SALE + Σ REVERSAL, signed, corrections
   * already folded into `sales`) — everything a resolution path (B660) needs to know the CURRENT
   * remaining for one line, re-derived fresh rather than trusted from park time. `null` when the
   * order has no SALE rows (the caller's original early return).
   */
  private async buildLineRemainingBalances(
    db: any,
    orderId: string,
  ): Promise<{
    sales: any[];
    productByItem: Map<string, string>;
    /** SA-789 F1: per SALE row id, how its line resolved (invoice item, else order line, else null). */
    resolvedBySaleId: Map<string, ResolvedSaleLine>;
    lineKeyOfSale: (s: any) => string;
    lineKeyOfReversal: (r: any) => string;
    invoiceItemIds: string[];
    remQtyByLine: Map<string, number>;
    remUnitBasisByLine: Map<string, number>;
    remNetByLine: Map<string, number>;
    remTaxByLine: Map<string, number>;
  } | null> {
    // The order's SALE rows are the snapshot we reverse against.
    // Deterministic row order (SA-170 W/N): both the live FIFO walk and the resumed one iterate
    // these rows, so an unordered read could hand two runs different walks.
    const sales = await db.regulatedSalesLedger.findMany({
      where: { orderId, entryType: "SALE" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (sales.length === 0) return null;

    // SALE rows carry no productId — recover it via each row's invoice item.
    const invoiceItemIds = [
      ...new Set(sales.map((s: any) => s.invoiceItemId).filter(Boolean)),
    ] as string[];
    const { productByItem, resolved: resolvedBySaleId } =
      await RegulatedLedgerService.productsByInvoiceItem(db, sales);

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
    // B671: `remaining`/`returnedByProduct` below are PIECE-denominated
    // (returnedPiecesByProduct), but a box-unaware line's own `qty` is stored in the LINE's
    // unit (boxes) — comparing pieces against a box count silently closed a whole multi-box
    // line on a fractional-box return (Opus review, B661 PR #1207). `unitBasisQty` (this PR)
    // is the row's own piece count, so it — not `qty` — is the axis capping/closesRow compares
    // `remaining` against. Tracked in parallel with remQtyByLine, same seeding.
    const remUnitBasisByLine = new Map<string, number>();
    const remNetByLine = new Map<string, number>(); // remaining net (>= 0 normally)
    const remTaxByLine = new Map<string, number>();
    for (const s of sales) {
      const lk = lineKeyOfSale(s);
      remQtyByLine.set(lk, (remQtyByLine.get(lk) ?? 0) + Number(s.qty));
      remUnitBasisByLine.set(lk, (remUnitBasisByLine.get(lk) ?? 0) + Number(s.unitBasisQty));
      remNetByLine.set(lk, (remNetByLine.get(lk) ?? 0) + Number(s.netSales));
      remTaxByLine.set(lk, (remTaxByLine.get(lk) ?? 0) + Number(s.categoryTax));
    }
    // Everything already reversed on these lines — earlier returns, invoice voids,
    // credit notes AND reconcile re-syncs — folded into the per-line remaining so
    // cumulative reversal can never exceed the sold amount regardless of which path
    // (or which since-rotated invoice item) booked the earlier reversal.
    // SA-789 F1: a reversal booked under the line's CURRENT (re-created) invoice item id carries the
    // order line, so it is found by that too — otherwise a return after such a credit over-reverses.
    const orderItemIds = [
      ...new Set(sales.map((s: any) => s.orderItemId).filter(Boolean)),
    ] as string[];
    const priorReversals = await db.regulatedSalesLedger.findMany({
      where: {
        entryType: "REVERSAL",
        OR: [
          { invoiceItemId: { in: invoiceItemIds } },
          ...(orderItemIds.length > 0 ? [{ orderItemId: { in: orderItemIds } }] : []),
        ],
      },
      select: {
        invoiceItemId: true,
        orderItemId: true,
        qty: true,
        unitBasisQty: true,
        netSales: true,
        categoryTax: true,
      },
    });
    for (const r of priorReversals) {
      const lk = lineKeyOfReversal(r);
      remQtyByLine.set(lk, (remQtyByLine.get(lk) ?? 0) + Number(r.qty)); // r.qty <= 0
      remUnitBasisByLine.set(lk, (remUnitBasisByLine.get(lk) ?? 0) + Number(r.unitBasisQty));
      remNetByLine.set(lk, (remNetByLine.get(lk) ?? 0) + Number(r.netSales));
      remTaxByLine.set(lk, (remTaxByLine.get(lk) ?? 0) + Number(r.categoryTax));
    }

    return {
      sales,
      productByItem,
      resolvedBySaleId,
      lineKeyOfSale,
      lineKeyOfReversal,
      invoiceItemIds,
      remQtyByLine,
      remUnitBasisByLine,
      remNetByLine,
      remTaxByLine,
    };
  }

  /**
   * SA-167 (OP-5, one routine): the per-product walk over an ordered list of SALE rows — book a
   * chunk capped at each row's line remaining, stop at the first row that PARKS (its leftover goes
   * to a parked row of its own). `reverseReturnEntries` (live) and `resolveParkedReversal`
   * (resumption) both drive it, so they can never disagree on row order or on what a still-legacy
   * row does with the leftover. Returns what is left unbooked and, if the walk stopped on a park,
   * that row and the pieces parked on it.
   */
  private async walkSaleRows(
    params: Omit<Parameters<RegulatedLedgerService["bookReversalChunk"]>[0], "s" | "remaining"> & {
      sales: any[];
      remaining: number;
    },
  ): Promise<{ remaining: number; parkedOn: { row: any; pieces: number } | null }> {
    const { sales, ...chunkParams } = params;
    let remaining = params.remaining;
    for (const s of sales) {
      if (remaining <= 0) break;
      const before = remaining;
      const chunk = await this.bookReversalChunk({ ...chunkParams, s, remaining });
      remaining = chunk.remaining;
      if (chunk.parked) return { remaining, parkedOn: { row: s, pieces: before } };
    }
    return { remaining, parkedOn: null };
  }

  async reverseReturnEntries(params: {
    returnId: string;
    orderId: string;
    returnedByProduct: Map<string, number>;
    /** Which unit `returnedByProduct`'s values are in — see the doc above. Required, never
     *  defaulted: the two callers disagree, and guessing wrong silently under- or
     *  over-reverses the filing. */
    returnedUnit: "LINE_UNIT" | "PIECES";
    db: any;
  }): Promise<void> {
    const { returnId, orderId, returnedByProduct, returnedUnit, db } = params;
    if (!returnedByProduct || returnedByProduct.size === 0) return;

    // Idempotency key is (returnId, orderId), not returnId alone (PR-1a/§5): an INLINE
    // return's goods can be sold across MULTIPLE source orders, and this method is called
    // once PER source order (`orderId` here is the SOURCE order, `ret.orderId` for a
    // STANDARD caller — see receive()). Keying on returnId alone would treat the second
    // source order's call as an already-reversed no-op. A STANDARD return has exactly one
    // source order, so this is a no-op change for it.
    const prior = await db.regulatedSalesLedger.findMany({
      where: { returnId, orderId, entryType: "REVERSAL" },
      select: { id: true },
    });
    if (prior.length > 0) return;

    const built = await this.buildLineRemainingBalances(db, orderId);
    if (!built) return;
    const {
      sales,
      productByItem,
      resolvedBySaleId,
      lineKeyOfSale,
      remQtyByLine,
      remUnitBasisByLine,
      remNetByLine,
      remTaxByLine,
    } = built;

    // SALE rows grouped by product (FIFO within a product). Only LIVE sale rows
    // (invoice item still present; or, SA-789/SA-835, a row whose invoice item was re-created and whose
    // order line has NO live row) are reversal targets; the per-line remaining
    // above already accounts for the pre-reconcile rows on the deleted items.
    // SA-070(b) Hazard 1: a `correctsEntryId != null` row is a units-only B681 correction
    // typed like the row it corrects (its own qty/net are 0, unitBasisQty is a delta) — it is
    // ALREADY folded into remQtyByLine/remUnitBasisByLine/etc above (it's still in `sales`), but
    // must never be iterated here as a candidate to reverse against: on the PIECES axis it would
    // consume returned pieces against a zero-net row and book a reversal with a unit basis but no
    // money.
    const salesByProduct = new Map<string, any[]>();
    const unresolvedSales: any[] = [];
    for (const s of sales) {
      if (s.correctsEntryId != null) continue;
      const pid = productByItem.get(s.invoiceItemId);
      if (!pid) {
        // SA-789 F1: a row that resolves through NEITHER its invoice item NOR its order line is
        // never skipped silently. (An unlisted line that resolves but has no product is a normal skip.)
        if (resolvedBySaleId.get(s.id)?.line == null) unresolvedSales.push(s);
        continue;
      }
      if (!salesByProduct.has(pid)) salesByProduct.set(pid, []);
      salesByProduct.get(pid)!.push(s);
    }
    // B681/SA-067: only the PIECES caller (the LINE_UNIT caller compares boxes to boxes
    // correctly on a box-unaware row and must not park it) — preloaded once for every candidate
    // row across every product, not per-row, to keep this one batch of queries regardless of how
    // many products/rows the return touches.
    const candidateSales = [...salesByProduct.values()].flat();
    const lineShapeBySaleId =
      returnedUnit === "PIECES"
        ? await resolveSaleLines(db, candidateSales)
        : new Map<string, ResolvedSaleLine>();
    const correctionsBySaleId =
      returnedUnit === "PIECES"
        ? await this.loadCorrectionsBySaleId(
            db,
            candidateSales.map((s) => s.id),
          )
        : new Map<string, SaleAxisCorrection[]>();
    const packNowByProduct =
      returnedUnit === "PIECES"
        ? await this.loadProductPackNow(db, [
            ...new Set([...lineShapeBySaleId.values()].map((v) => v.productId).filter(Boolean)),
          ] as string[])
        : new Map<string, number | null>();

    const now = new Date();
    const bucket = periodBucketOf(now);
    const rows: any[] = [];

    // Which per-line remaining map is the CALLER's own axis — the one `returnedByProduct`'s
    // values are directly comparable against (cap, closesRow, and the pro-rata fraction all
    // read off this one; the other axis is DERIVED from it, never independently clamped).
    const nativeRemByLine = returnedUnit === "PIECES" ? remUnitBasisByLine : remQtyByLine;

    const unbookedByProduct: Record<string, number> = {};
    for (const [productId, returnedQtyRaw] of returnedByProduct.entries()) {
      const remaining = Number(returnedQtyRaw);
      if (!(remaining > 0)) continue;
      const walked = await this.walkSaleRows({
        db,
        sales: salesByProduct.get(productId) ?? [],
        remaining,
        returnId,
        orderId,
        returnedUnit,
        bucket,
        now,
        lineKeyOfSale,
        nativeRemByLine,
        remQtyByLine,
        remUnitBasisByLine,
        remNetByLine,
        remTaxByLine,
        lineShapeBySaleId,
        correctionsBySaleId,
        packNowByProduct,
        rows,
      });
      if (walked.remaining > 0 && !walked.parkedOn) unbookedByProduct[productId] = walked.remaining;
    }

    // SA-835: a SALE row that resolves nowhere (its line is gone) is never skipped silently. Raise the
    // notice only when it matters: the row's line still holds a balance AND returned units are still
    // unbooked after the walk (a return of other goods books nothing there and is no loss).
    const unbookedQty = Object.values(unbookedByProduct).reduce((n, q) => n + q, 0);
    if (unbookedQty > 0) {
      for (const s of unresolvedSales) {
        if (!((remQtyByLine.get(lineKeyOfSale(s)) ?? 0) > 0)) continue;
        await this.reportUnbookedReversal(db, {
          tenantId: s.tenantId,
          message: `A return could not be reversed on the regulated ledger: the sold line on order ${s.orderId} (ledger entry ${s.id}) can no longer be found. Support needs to resolve it.`,
          meta: unbookedReversalMeta({
            tenantId: s.tenantId,
            returnId,
            creditNoteId: null,
            lineId: s.orderItemId ?? null,
            saleEntryId: s.id,
            qty: unbookedQty,
            unbookedByProduct,
            period: periodBucketOf(new Date()),
          }),
        });
      }
    }

    if (rows.length === 0) return;
    await db.regulatedSalesLedger.createMany({ data: rows });
  }

  /**
   * B662: an ISSUED invoice was re-priced, so the ledger's net and category tax for its regulated lines no
   * longer match the invoice. Book ONE append-only CORRECTION row per line whose held figure differs from
   * its target (`priceCorrectionTarget`): entryType SALE for an increase, REVERSAL for a decrease, signed
   * `netSales` / `categoryTax` deltas, qty and unitBasisQty 0 (a price change moves no units), booked in
   * the CURRENT period (never backdated: a filed period is not reopened), with `correctsEntryId` = the
   * SALE row corrected and `originalSoldAt` = its sold date. Every id is copied from that SALE row, so an
   * invoice that later returns to draft re-syncs over the SALE AND its corrections (`reverseInvoiceEntries`
   * nets every row of the invoice line). Idempotent: the delta is computed against what the ledger
   * holds, so a repeated adjustment writes nothing. A line with no live SALE row, or nothing left (fully
   * returned / voided), is skipped. Returns the number of rows written. DRAFT invoices never come here:
   * they re-sync (`resyncInvoiceLedger`), so a correction can never orphan on a reversed SALE.
   */
  async correctSaleForPriceChange(params: {
    invoiceId: string;
    lines: PriceCorrectionLine[];
    db: any;
  }): Promise<number> {
    const { invoiceId, lines, db } = params;
    if (lines.length === 0) return 0;
    const all: any[] = await db.regulatedSalesLedger.findMany({
      where: { invoiceId, invoiceItemId: { in: lines.map((l) => l.invoiceItemId) } },
    });
    const byItem = new Map<string, any[]>();
    for (const r of all) byItem.set(r.invoiceItemId, [...(byItem.get(r.invoiceItemId) ?? []), r]);

    const now = new Date();
    const bucket = periodBucketOf(now);
    const EPS = 0.005;
    const rows: any[] = [];
    for (const line of lines) {
      const held = byItem.get(line.invoiceItemId) ?? [];
      // The live SALE this line's corrections point at: the newest base sale (not itself a correction).
      const base = held
        .filter((r) => r.entryType === "SALE" && r.correctsEntryId == null && Number(r.qty) > 0)
        .sort((a, b) => +new Date(b.createdAt ?? 0) - +new Date(a.createdAt ?? 0))[0];
      if (!base) continue;
      const heldQty = held.reduce((n, r) => n + Number(r.qty), 0);
      if (!(heldQty > 0.0005)) continue; // nothing left in the ledger for this line
      const heldNet = held.reduce((n, r) => n + Number(r.netSales), 0);
      const heldTax = held.reduce((n, r) => n + Number(r.categoryTax), 0);
      const dNet = roundMoney(priceCorrectionTarget(line.netSales, heldQty, line) - heldNet);
      const dTax = roundMoney(priceCorrectionTarget(line.categoryTax, heldQty, line) - heldTax);
      if (Math.abs(dNet) < EPS && Math.abs(dTax) < EPS) continue;
      const decrease = (Math.abs(dNet) >= EPS ? dNet : dTax) < 0;
      rows.push({
        tenantId: base.tenantId,
        trackedCategoryId: base.trackedCategoryId,
        trackedSubcategoryId: base.trackedSubcategoryId ?? null,
        entryType: decrease ? ("REVERSAL" as const) : ("SALE" as const),
        orderId: base.orderId,
        orderItemId: base.orderItemId,
        invoiceId: base.invoiceId,
        invoiceItemId: line.invoiceItemId,
        qty: 0,
        unitBasisQty: 0,
        netSales: dNet,
        categoryTax: dTax,
        soldAt: now,
        originalSoldAt: base.soldAt,
        correctsEntryId: base.id,
        periodBucket: bucket,
      });
    }
    if (rows.length === 0) return 0;
    await db.regulatedSalesLedger.createMany({ data: rows });
    return rows.length;
  }

  /**
   * Undo a return's REVERSAL rows when the return is CANCELLED before being
   * refunded (symmetric to cancel() deleting the return's stock movements). A
   * delete — not a counter-entry — keeps the `returnId` idempotency guard clean so
   * the order can be legitimately returned again later.
   */
  async unreverseReturnEntries(params: { returnId: string; db: any }): Promise<void> {
    const { returnId, db } = params;
    // Opus review (B660 PR B, #1324) caught this comment describing the WRONG thing: this
    // delete is unconditional on `entryType: "REVERSAL"` for the returnId, with no
    // `resolvedAt` filter — so it DOES undo a REVERSAL that SA-089's resolveParkedReversal
    // booked against this exact return (that booked row carries this `returnId`, same as any
    // other reversal). Cancelling a return after its parked reversal was resolved therefore:
    // (1) deletes the booked REVERSAL row itself — correct, the return is undone, so nothing
    // should remain reversed against it; (2) leaves the `RegulatedLedgerParkedReversal` row
    // itself alone (its own delete below is `resolvedAt: null`-scoped, so an already-resolved
    // row survives) — but that row's `resolvedEntryId` now DANGLES, pointing at a row that no
    // longer exists; nothing currently reads `resolvedEntryId` back out expecting it to
    // resolve, so this is a known, accepted gap rather than a live bug. (3) leaves both kinds
    // of restatement correction rows the resolution wrote (the SALE's basis fix and each
    // earlier box-axis reversal's own correction) untouched — they deliberately carry no
    // `returnId` (they restate historical fact, not this-return-specific fact), so neither
    // delete below can touch them, and the SALE stays correctly classified piece-axis forever
    // after regardless of what happens to this one return.
    await db.regulatedSalesLedger.deleteMany({ where: { returnId, entryType: "REVERSAL" } });
    // B681/SA-067(4): a return this guard parked (because its sale row's box/piece axis
    // couldn't be classified) leaves a RegulatedLedgerParkedReversal row blocking its period's
    // filing. Without this, cancelling that return before the park is ever resolved leaves the
    // row behind forever — deleted here, not resolved, because the return itself is undone, so
    // there is nothing left to resolve it against. Only this return's UNRESOLVED rows: a row
    // already resolved (resolvedAt set) recorded a real filing decision (see above) and must
    // survive as a record, even though its resolvedEntryId now dangles.
    await db.regulatedLedgerParkedReversal.deleteMany({ where: { returnId, resolvedAt: null } });
  }

  /**
   * #2108: the ONE product-id definition for a parked sale row: its live invoice item's product,
   * else the product of the order/invoice line shape (`resolveSaleLines`), which survives an
   * InvoiceItem rotation. list() (`filedPeriodForParked`) and `resolveParkedReversal` both call it.
   */
  static productIdOfParkedRow(
    saleRow: any,
    productByItem: Map<string, string>,
    shapeProductId: string | null | undefined,
  ): string | null {
    return productByItem.get(saleRow.invoiceItemId) ?? shapeProductId ?? null;
  }

  /**
   * #2108 / SA-196: the ONE definition of which categories a parked-reversal resolution touches: the
   * parked row's own plus every live sale row of the same product on the order (correction rows
   * excluded). A product re-categorised between two sales has rows in different categories, each with
   * its own filing, so the conservative fold looks at all of them. `resolveParkedReversal` and the
   * parked-reversal list both call this, so what the operator is told before resolving is what the
   * resolution then does.
   */
  static touchedCategoryIds(
    saleRow: any,
    sales: any[],
    productByItem: Map<string, string>,
    productId: string | null | undefined,
  ): string[] {
    return [
      ...new Set(
        [
          saleRow,
          ...sales.filter(
            (x: any) =>
              x.correctsEntryId == null &&
              productId != null &&
              productByItem.get(x.invoiceItemId) === productId,
          ),
        ]
          .map((x: any) => x.trackedCategoryId)
          .filter(Boolean),
      ),
    ] as string[];
  }

  /** The filed period (any of `categoryIds`) that contains `bucket`, or null. Deterministic: with two
   *  filed categories the lowest category id, then period key, wins (SA-213), and the matched category
   *  is returned so the response names the right one. */
  async findFiledPeriod(
    db: any,
    categoryIds: string[],
    bucket: string,
  ): Promise<FiledPeriod | null> {
    if (categoryIds.length === 0) return null;
    const bucketStart = new Date(`${bucket}-01T00:00:00.000Z`);
    const filing = await db.regulatedFiling.findFirst({
      where: {
        trackedCategoryId: { in: categoryIds },
        periodStart: { lte: bucketStart },
        periodEnd: { gt: bucketStart },
        status: { in: ["GENERATED", "LOCKED"] },
      },
      orderBy: [{ trackedCategoryId: "asc" }, { periodKey: "asc" }],
      select: { periodKey: true, status: true, trackedCategoryId: true },
    });
    return filing
      ? {
          periodKey: filing.periodKey,
          status: filing.status,
          trackedCategoryId: filing.trackedCategoryId,
        }
      : null;
  }

  /** Read-only: would resolving this parked row book into an already-filed period? Uses the SAME fold
   *  and the SAME lookup as `resolveParkedReversal` (the park's date derives the bucket; a park in the
   *  current month is never "filed"). */
  async filedPeriodForParked(
    db: any,
    parked: { saleEntryId: string; orderId: string; createdAt: Date | string },
  ): Promise<FiledPeriod | null> {
    const bucket = periodBucketOf(new Date(parked.createdAt));
    if (bucket === periodBucketOf(new Date())) return null;
    const saleRow = await db.regulatedSalesLedger.findFirst({ where: { id: parked.saleEntryId } });
    if (!saleRow) return null;
    const sales: any[] =
      (await db.regulatedSalesLedger.findMany({
        where: { orderId: parked.orderId, entryType: "SALE" },
      })) ?? [];
    const { productByItem } = await RegulatedLedgerService.productsByInvoiceItem(db, sales);
    const shape = (await resolveSaleLines(db, [saleRow])).get(saleRow.id);
    return this.findFiledPeriod(
      db,
      RegulatedLedgerService.touchedCategoryIds(
        saleRow,
        sales,
        productByItem,
        RegulatedLedgerService.productIdOfParkedRow(saleRow, productByItem, shape?.productId),
      ),
      bucket,
    );
  }

  /**
   * SA-089a (amends SA-089, recorded as the SA's error E50) — B660: the operator resolution of
   * ONE parked reversal row. Lives here (not a separate injectable) because both
   * `buildLineRemainingBalances` and `bookReversalChunk` are private to this class — SA-090's
   * own note. `ParkedReversalResolutionService` (returns module) is the thin claim-first/audit
   * wrapper that calls this inside its own transaction, under the Return then Order row locks (no
   * advisory lock); this method does no claiming, no locking and no auditing, only the
   * classify/correct/book money math, so it can be called from inside the wrapper's own locked
   * `tenantTransaction`.
   *
   * WHICH PACK (SA-089 §1, unchanged): re-runs `classifySaleAxis` with the sale row's OWN line
   * shape, `unitsPerBox` REPLACED by the operator-supplied pack (never the line's own
   * stale/absent snapshot, never the live product) — a line with none resolved at all (deleted
   * invoice item, orphaned order item) uses the supplied pack as the WHOLE shape. `unknown`
   * after the pack refuses outright — nothing is written, the row stays parked.
   *
   * CLOSED IS DECIDED FIRST (SA-089a(a)): before any write, the line's remaining qty AND net —
   * on the ORIGINAL, UNCORRECTED axis — decide whether there is anything left to correct. Both
   * ≤ EPS means the line was already fully reversed before this operator ever touched it: nothing
   * is written on THAT row, not even the SALE correction (SA-169: the parked pieces still walk on to
   * the product's other live rows, so the outcome is `closed` only when nothing booked, parked or
   * was left over, and `partial` otherwise). Deciding this AFTER
   * writing the SALE's restatement (E50's mistake) manufactures a correction for a line that
   * needed none.
   *
   * TWO-PART RESTATEMENT (SA-089a(b)) — legacy verdict only: E50 was restating only the SALE
   * (`+qty*(pack-1)`) while leaving every earlier BOX-axis reversal at its stored `-r` (box
   * units), so the line's remaining read as `qty*pack - Σr` instead of `(qty-Σr)*pack` —
   * `Σr*(pack-1)` phantom units on the filing (a fully-voided 5-box line resolved at 12 read
   * +50 instead of 0). The fix restates BOTH: the SALE gets the full `+qty*(pack-1)` (so the
   * classifier reads piece-axis forever after — SA-070 hazard 2), AND every earlier BOX-axis
   * reversal `r` against this line (`|unitBasisQty| == |qty|`, a signature a reversal only has
   * when it was booked LINE_UNIT against a still-legacy sale; a fractional credit-note ratio
   * gives a fractional `r`) gets its OWN REVERSAL-typed correction (`correctsEntryId` that
   * reversal, `originalSoldAt` its own `soldAt`, `qty: 0`, `unitBasisQty: -|r|*(pack-1)`, `net:
   * 0`, `tax: 0`). After both, every row on the line reads on ONE axis and remaining sums to
   * exactly `(qty-Σr)*pack`. Correcting only the SALE's un-reversed boxes (`(qty-Σr)*(pack-1)`)
   * is REJECTED — it leaves the SALE's basis at neither `qty` nor `qty*pack`, the classifier
   * reads unknown, and the next return parks again (hazard 2 reopened).
   *
   * REMAINING CHANGED SINCE PARKING (SA-089 §2, unchanged): `buildLineRemainingBalances` is
   * called FRESH, never the parked row's own stale `returnedPieces` denominator — later
   * returns/credits/corrections (including the two just written) are folded in automatically.
   * `bookReversalChunk` (the SAME booker the live reversal path uses) caps the booking at the
   * line's current remaining; a capped booking is not an error.
   *
   * VERDICT AFTER (Opus LOW): `verdictAfter` on a `booked`/`closed` outcome is the verdict
   * AFTER any correction was written, not the pre-correction one — a legacy row reads
   * `piece-axis` here once restated, proving the restatement actually took.
   *
   * ONE-WAY (SA-089 §4, unchanged): this method makes no resolved/claim state of its own — the
   * wrapper stamps `resolvedAt`/`unitsPerBoxSupplied` under the SAME transaction as the DB
   * writes this method makes, so a caller that rolls back the transaction rolls back every
   * correction row and the REVERSAL row together with the claim.
   */
  async resolveParkedReversal(
    db: any,
    parked: {
      returnId: string;
      orderId: string;
      orderItemId: string | null;
      saleEntryId: string;
      returnedPieces: number;
      /** SA-182: the parked row's own period and the return's date (the row's createdAt). Optional
       *  so a caller without them books in the current period, as before. */
      periodBucket?: string;
      parkedAt?: Date;
    },
    pack: number,
  ): Promise<{
    /** `partial` (SA-167): something was booked or parked but not everything — read
     *  `parkedPieces`/`unbookedPieces`; a bare `booked` means every returned piece is booked. */
    outcome: "booked" | "partial" | "closed" | "unresolvable";
    correctionEntryId: string | null;
    /** The FIRST REVERSAL row booked. */
    resolvedEntryId: string | null;
    bookedPieces: number;
    bookedQty: number;
    bookedNet: number;
    bookedTax: number;
    /** Pieces parked on a NEW parked row (a still-legacy row further down the walk). */
    parkedPieces: number;
    parkedRowIds: string[];
    /** Pieces the walk could not book anywhere (an over-return), mirroring the live path. */
    unbookedPieces: number;
    /** SA-182: set when the parked period was already filed, so the reversal was booked in the
     *  CURRENT period instead (an amended return may be required for `periodKey`). */
    amendedPeriod?: FiledPeriod | null;
    /** SA-193: existing UNRESOLVED parks the leftover was added to (never a new key). */
    grownParks?: { id: string; added: number }[];
    verdictAfter: SaleAxisState | null;
    unresolvableReason: string | null;
  }> {
    const EPS = 0.0005; // matches this file's own reverseInvoiceEntries / @routeflow/pricing's legacy-box-axis EPS
    const unresolvable = (reason: string, correctionEntryId: string | null = null) => ({
      outcome: "unresolvable" as const,
      correctionEntryId,
      resolvedEntryId: null,
      bookedPieces: 0,
      bookedQty: 0,
      bookedNet: 0,
      bookedTax: 0,
      parkedPieces: 0,
      parkedRowIds: [] as string[],
      unbookedPieces: 0,
      verdictAfter: null,
      unresolvableReason: reason,
    });

    const saleRow = await db.regulatedSalesLedger.findFirst({
      where: { id: parked.saleEntryId },
    });
    // The sale row should never actually be missing (it is never deleted elsewhere) — treated
    // as unresolvable rather than silently booking against nothing if it somehow is.
    if (!saleRow) return unresolvable("the sale row no longer exists");

    const shapes = await resolveSaleLines(db, [saleRow]);
    const shape = shapes.get(saleRow.id) ?? { line: null, productId: null };
    const lineWithSuppliedPack: SaleAxisLine = shape.line
      ? { ...shape.line, unitsPerBox: pack }
      : { boxes: null, pieces: null, unitLabel: null, unitsPerBox: pack };

    let correctionsBySaleId = await this.loadCorrectionsBySaleId(db, [saleRow.id]);
    const classify = () =>
      classifySaleAxis(
        {
          entryType: saleRow.entryType,
          qty: saleRow.qty,
          unitBasisQty: saleRow.unitBasisQty,
          writtenAt: saleRow.createdAt ?? null,
        },
        lineWithSuppliedPack,
        correctionsBySaleId.get(saleRow.id) ?? [],
        pack,
      );
    const verdict = classify();
    if (verdict.state === "unknown") return unresolvable(verdict.reason);

    // SA-089a(a): decide CLOSED from the line's remaining on the ORIGINAL, uncorrected axis —
    // before any correction is written. A line already fully reversed before this operator
    // touched it gets NOTHING written, not even the SALE restatement.
    const builtBefore = await this.buildLineRemainingBalances(db, parked.orderId);
    if (!builtBefore) return unresolvable("no SALE rows remain on this order");
    const lineKey = builtBefore.lineKeyOfSale(saleRow);
    const remQtyBefore = builtBefore.remQtyByLine.get(lineKey) ?? 0;
    const remNetBefore = builtBefore.remNetByLine.get(lineKey) ?? 0;
    // SA-169: "closed" is a property of THIS row's line — nothing to correct or reverse on it —
    // but the parked pieces belong to the PRODUCT's return, so the walk below still carries them to
    // the order's other live rows (the SA-167 hole through a second door).
    const rowClosed = Math.abs(remQtyBefore) <= EPS && Math.abs(remNetBefore) <= EPS;

    let correctionEntryId: string | null = null;
    if (!rowClosed && verdict.state === "legacy") {
      const qty = Number(saleRow.qty);
      // SA-134 (amends SA-089a, SA error E51): every correction row's periodBucket is derived
      // from ITS OWN soldAt (never copied from the row it corrects, never a filed period) — one
      // `now` shared by the SALE correction and every reversal correction below so soldAt and
      // periodBucket can never disagree with each other or with each other's row.
      const now = new Date();
      const bucketNow = periodBucketOf(now);
      const correction: RegulatedCorrectionRowInput = {
        tenantId: saleRow.tenantId,
        trackedCategoryId: saleRow.trackedCategoryId,
        trackedSubcategoryId: saleRow.trackedSubcategoryId ?? null,
        entryType: "SALE",
        orderId: saleRow.orderId ?? parked.orderId,
        orderItemId: saleRow.orderItemId,
        invoiceId: saleRow.invoiceId,
        invoiceItemId: saleRow.invoiceItemId,
        correctsEntryId: saleRow.id,
        originalSoldAt: saleRow.soldAt,
        soldAt: now,
        qty: 0,
        unitBasisQty: qty * (pack - 1),
        netSales: 0,
        categoryTax: 0,
        periodBucket: bucketNow,
      };
      const created = await db.regulatedSalesLedger.create({ data: correction });
      correctionEntryId = created.id;

      // SA-089a(b): every earlier BOX-axis reversal against this same line also gets restated,
      // never left at its stale box-denominated figure. A reversal only has |unitBasisQty| ==
      // |qty| when it was booked LINE_UNIT against a still-legacy sale (a genuine piece-axis
      // reversal's unitBasisQty diverges from its qty by construction) — never re-corrected if
      // it already carries a correction of its own (defensive; the one-way design means this
      // should not happen in practice).
      {
        // SA-167(2): select by the SAME line key the balance builder folds reversals in by
        // (`lineKeyOfReversal`: the order line, else the invoice item), never by this row's invoice
        // item alone — a split or replaced invoice item's reversal carries a different
        // invoiceItemId but the same order line and would escape the restatement.
        const lineOrs: any[] = [
          { invoiceItemId: { in: builtBefore.invoiceItemIds } },
          ...(saleRow.orderItemId ? [{ orderItemId: saleRow.orderItemId }] : []),
        ];
        const candidateReversals = (
          await db.regulatedSalesLedger.findMany({
            where: { entryType: "REVERSAL", OR: lineOrs },
          })
        ).filter((r: any) => builtBefore.lineKeyOfReversal(r) === lineKey);
        for (const r of candidateReversals) {
          if (r.correctsEntryId != null) continue;
          const rQty = Number(r.qty);
          const rUnitBasis = Number(r.unitBasisQty);
          if (rQty === 0) continue;
          if (Math.abs(Math.abs(rUnitBasis) - Math.abs(rQty)) > EPS) continue;
          const reversalCorrection: RegulatedCorrectionRowInput = {
            tenantId: r.tenantId,
            trackedCategoryId: r.trackedCategoryId,
            trackedSubcategoryId: r.trackedSubcategoryId ?? null,
            entryType: "REVERSAL",
            orderId: r.orderId,
            orderItemId: r.orderItemId,
            invoiceId: r.invoiceId,
            invoiceItemId: r.invoiceItemId,
            correctsEntryId: r.id,
            originalSoldAt: r.soldAt,
            soldAt: now,
            qty: 0,
            unitBasisQty: -Math.abs(rQty) * (pack - 1),
            netSales: 0,
            categoryTax: 0,
            periodBucket: bucketNow,
          };
          await db.regulatedSalesLedger.create({ data: reversalCorrection });
        }
      }

      // Refresh so bookReversalChunk's OWN classify call below folds the new row in and
      // answers piece-axis — it must never re-park what was just corrected.
      correctionsBySaleId = await this.loadCorrectionsBySaleId(db, [saleRow.id]);
    }

    const built = await this.buildLineRemainingBalances(db, parked.orderId);
    if (!built) return unresolvable("no SALE rows remain on this order", correctionEntryId);
    const { lineKeyOfSale, remQtyByLine, remUnitBasisByLine, remNetByLine, remTaxByLine } = built;

    // SA-193 (amends SA-182): ONE source for the date and the bucket. The booked REVERSAL's soldAt is the
    // park's date and its periodBucket is DERIVED from that date (never read from the row: a stored
    // bucket that disagrees is logged and the date wins; no clamping). No park date -> both are now.
    // If the derived period is already filed (GENERATED or LOCKED) the reversal books in the CURRENT
    // period with `originalSoldAt` = the park date and the result says so (never silent). Rows the
    // resumed walk parks carry the ORIGINAL date and the original month (so their own resolution
    // re-derives the filed branch); the axis-correction rows above keep periodBucketOf(now) (SA-134).
    const nowActual = new Date();
    const currentBucket = periodBucketOf(nowActual);
    const returnDate: Date | null = parked.parkedAt ?? null;
    const parkBucket = returnDate ? periodBucketOf(returnDate) : currentBucket;
    if (returnDate && parked.periodBucket && parked.periodBucket !== parkBucket) {
      this.logger.warn(
        `parked reversal ${parked.saleEntryId}: stored periodBucket ${parked.periodBucket} disagrees with its date ` +
          `(${parkBucket}); the date wins.`,
      );
    }
    let filedPeriod: FiledPeriod | null = null;
    if (returnDate && parkBucket !== currentBucket) {
      // SA-196: conservative across categories, through the ONE shared fold (list() uses the same one).
      const walkProductId = RegulatedLedgerService.productIdOfParkedRow(
        saleRow,
        built.productByItem,
        shape.productId,
      );
      filedPeriod = await this.findFiledPeriod(
        db,
        RegulatedLedgerService.touchedCategoryIds(
          saleRow,
          built.sales,
          built.productByItem,
          walkProductId,
        ),
        parkBucket,
      );
    }
    const now = returnDate && !filedPeriod ? returnDate : nowActual;
    const bucket = returnDate && !filedPeriod ? parkBucket : currentBucket;
    const rows: RegulatedCorrectionRowInput[] = [];
    const walkBase = {
      db,
      returnId: parked.returnId,
      orderId: parked.orderId,
      returnedUnit: "PIECES" as const,
      bucket,
      now,
      lineKeyOfSale,
      nativeRemByLine: remUnitBasisByLine,
      remQtyByLine,
      remUnitBasisByLine,
      remNetByLine,
      remTaxByLine,
      rows,
      parkBucket,
      ...(returnDate ? { parkDate: returnDate } : {}),
      ...(filedPeriod && returnDate ? { originalSoldAt: returnDate } : {}),
    };
    // The parked row first, on the operator's pack; then RESUME the live walk (SA-167).
    const chunk = rowClosed
      ? { remaining: parked.returnedPieces, parked: false }
      : await this.bookReversalChunk({
          ...walkBase,
          s: saleRow,
          remaining: parked.returnedPieces,
          lineShapeBySaleId: new Map([
            [saleRow.id, { line: lineWithSuppliedPack, productId: shape.productId }],
          ]),
          correctionsBySaleId,
          packNowByProduct: new Map(shape.productId ? [[shape.productId, pack]] : []),
        });

    // Defensive: our own pre-classify above already ruled out "unknown", so
    // bookReversalChunk's internal re-classify (same data, now with both corrections folded
    // in) should never disagree and park again — if it somehow does, treat it as unresolvable
    // rather than silently reporting success.
    if (chunk.parked)
      return unresolvable("classification disagreed after correction", correctionEntryId);

    // Opus LOW: verdictAfter is the verdict AFTER any correction was written, not the
    // pre-correction one — proves the restatement actually took (a legacy row reads
    // piece-axis here).
    const verdictAfter = classify().state;

    // SA-167 (the Opus REQUIRED silent under-reversal): the park recorded the product's WHOLE
    // leftover on this first legacy row; whatever this row could not absorb continues down the
    // product's remaining live sale rows through the SAME walk the live path runs. An over-return is
    // reported, never invented. SA-193: the walk NEVER mints onto an existing key. For each row it
    // may park on, it first reads the park for (returnId, row): a RESOLVED one is the operator's
    // attestation (the row books, never re-parks or re-opens); an UNRESOLVED one is grown by the
    // leftover in this same transaction (reported in `grownParks`); otherwise a park is created.
    let leftover = chunk.remaining;
    let parkedPieces = 0;
    const parkedRowIds: string[] = [];
    const grownParks: { id: string; added: number }[] = [];
    if (leftover > 0) {
      const productId = RegulatedLedgerService.productIdOfParkedRow(
        saleRow,
        built.productByItem,
        shape.productId,
      );
      const ordered = built.sales.filter(
        (s: any) =>
          s.correctsEntryId == null &&
          productId != null &&
          built.productByItem.get(s.invoiceItemId) === productId,
      );
      // EVERY other live row of the product, in the live path's own order (a fully reversed row
      // skips itself inside the chunk booker) — not only rows after the parked one.
      const rest = ordered.filter((s: any) => s.id !== saleRow.id);
      if (rest.length > 0) {
        const restShapes = await resolveSaleLines(db, rest);
        const restCorrections = await this.loadCorrectionsBySaleId(
          db,
          rest.map((s: any) => s.id),
        );
        const restPackNow = await this.loadProductPackNow(db, [
          ...new Set([...restShapes.values()].map((v) => v.productId).filter(Boolean)),
        ] as string[]);
        // SA-173: for the parked row's product the operator has just ATTESTED the pack on this
        // order, so it overrides the live product read for the resumed walk too (the same entry row 1
        // uses). Otherwise a product un-boxed after the sale would read a later legacy-shaped row as
        // non-boxed-now and book its box count as pieces inside a resolution. It is NOT applied as the
        // rows' own pack: they stay legacy and PARK, so the audit shows one attestation per row.
        // Only a pack > 1 is an attestation that the product IS boxed. A pack of 1 (allowed, "this line
        // was never really boxed") says nothing about the SIBLING rows, and applying it as the boxed test
        // would flip a legacy-shaped sibling on a product that is boxed today from PARK to BOOK-as-pieces
        // (its box count reversed as pieces: full net and tax on 3 "pieces"). Then the live read stands.
        if (productId && pack > 1) restPackNow.set(productId, pack);

        const existingParks: any[] =
          (await db.regulatedLedgerParkedReversal.findMany({
            where: {
              returnId: parked.returnId,
              saleEntryId: { in: rest.map((s: any) => s.id) },
            },
          })) ?? [];
        const attestedPackBySaleId = new Map<string, number>();
        const unresolvedBySale = new Map<string, any>();
        for (const p of existingParks) {
          if (p.resolvedAt != null)
            attestedPackBySaleId.set(p.saleEntryId, Number(p.unitsPerBoxSupplied ?? 1));
          else unresolvedBySale.set(p.saleEntryId, p);
        }
        const parkOverride = async (row: any) => {
          const existing = unresolvedBySale.get(row.saleEntryId);
          if (existing) {
            await db.regulatedLedgerParkedReversal.update({
              where: { id: existing.id },
              data: { returnedPieces: Number(existing.returnedPieces) + row.returnedPieces },
            });
            grownParks.push({ id: existing.id, added: row.returnedPieces });
            parkedRowIds.push(existing.id);
          } else {
            const created = await db.regulatedLedgerParkedReversal.create({ data: row });
            parkedRowIds.push(created.id);
          }
        };
        const walked = await this.walkSaleRows({
          ...walkBase,
          sales: rest,
          remaining: leftover,
          lineShapeBySaleId: restShapes,
          correctionsBySaleId: restCorrections,
          packNowByProduct: restPackNow,
          attestedPackBySaleId,
          parkOverride,
        });
        leftover = walked.remaining;
        if (walked.parkedOn) parkedPieces = walked.parkedOn.pieces;
      }
    }
    const unbookedPieces = parkedPieces > 0 ? 0 : Math.max(0, leftover);

    if (rows.length === 0) {
      return {
        // "closed" only when the walk booked, parked AND left nothing unbooked (SA-169, SA-193): a
        // leftover is never hidden behind "closed".
        outcome: parkedPieces > 0 || unbookedPieces > 0 ? "partial" : "closed",
        correctionEntryId,
        resolvedEntryId: null,
        bookedPieces: 0,
        bookedQty: 0,
        bookedNet: 0,
        bookedTax: 0,
        parkedPieces,
        parkedRowIds,
        unbookedPieces,
        amendedPeriod: filedPeriod,
        grownParks,
        verdictAfter,
        unresolvableReason: null,
      };
    }

    let firstId: string | null = null;
    let bookedPieces = 0;
    let bookedQty = 0;
    let bookedNet = 0;
    let bookedTax = 0;
    for (const row of rows) {
      const created = await db.regulatedSalesLedger.create({ data: row });
      firstId ??= created.id;
      bookedPieces += -Number(created.unitBasisQty);
      bookedQty += -Number(created.qty);
      bookedNet += -Number(created.netSales);
      bookedTax += -Number(created.categoryTax);
    }
    return {
      outcome: parkedPieces > 0 || unbookedPieces > 0 ? "partial" : "booked",
      correctionEntryId,
      resolvedEntryId: firstId,
      bookedPieces: round3(bookedPieces),
      bookedQty: round3(bookedQty),
      bookedNet: roundMoney(bookedNet),
      bookedTax: roundMoney(bookedTax),
      parkedPieces,
      parkedRowIds,
      unbookedPieces,
      amendedPeriod: filedPeriod,
      grownParks,
      verdictAfter,
      unresolvableReason: null,
    };
  }

  /**
   * SA-789 F1: a credited regulated item that matched NO SALE row, on an invoice that has SALE rows no
   * live invoice item and no other credited item accounts for, means the credit could not be tied to
   * its sale. It is made visible (log + notice), not skipped; a line that never recorded a SALE (an
   * invoice with no matching dangling row) stays the normal "no naked reversal" skip.
   */
  private async reportUnmatchedCredits(
    db: any,
    creditNoteId: string,
    unmatched: any[],
    creditedItems: any[],
    claimedRows: any[],
  ): Promise<void> {
    const invoiceIds = [
      ...new Set(
        unmatched
          .map((it) => creditedItems.find((c: any) => c.id === it.invoiceItemId)?.invoiceId)
          .filter(Boolean),
      ),
    ] as string[];
    if (invoiceIds.length === 0) return;
    const claimedItemIds = new Set(claimedRows.map((r: any) => r.invoiceItemId));
    const sales: any[] =
      (await db.regulatedSalesLedger.findMany({
        where: {
          invoiceId: { in: invoiceIds },
          entryType: "SALE",
          correctsEntryId: null,
          trackedCategoryId: { in: [...new Set(unmatched.map((it) => it.trackedCategoryId))] },
        },
        select: { id: true, invoiceId: true, invoiceItemId: true, orderItemId: true },
      })) ?? [];
    const candidates = sales.filter((r) => r.invoiceItemId && !claimedItemIds.has(r.invoiceItemId));
    if (candidates.length === 0) return;
    const resolvedRows = await resolveSaleLines(db, candidates);
    const dangling = candidates.filter((r) => !resolvedRows.get(r.id)?.liveInvoiceItemId);
    if (dangling.length === 0) return;
    for (const it of unmatched) {
      await this.reportUnbookedReversal(db, {
        tenantId: it.tenantId,
        message: `A credit note could not be reversed on the regulated ledger: credit note ${creditNoteId}, invoice line ${it.invoiceItemId} has no sale entry it can be tied to. Support needs to resolve it.`,
        meta: unbookedReversalMeta({
          tenantId: it.tenantId,
          returnId: null,
          creditNoteId,
          lineId: it.id ?? null,
          saleEntryId: dangling[0].id,
          qty: Number(it.qty),
          period: periodBucketOf(new Date()),
        }),
      });
    }
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

    // SA-789 F1: the credited items' order lines. A legacy rebuild re-creates the invoice items, so the
    // item being credited now is not the id the SALE row was written under; the order line is stable.
    // (This reads the CREDITED item, not a ledger row's id: that mapping lives in `resolveSaleLines`.)
    const creditedItems: any[] =
      (await db.invoiceItem.findMany({
        where: { id: { in: invoiceItemIds } },
        select: { id: true, orderItemId: true, invoiceId: true },
      })) ?? [];
    const creditedOrderItemIds = [
      ...new Set(creditedItems.map((c: any) => c.orderItemId).filter(Boolean)),
    ] as string[];

    // The credited lines' LIVE SALE rows — the source ids stamped onto reversals and
    // the SALE-existence guard (only a line that recorded a live regulated SALE can be
    // credited). Keyed by the credited invoice item.
    const liveSaleRows = await db.regulatedSalesLedger.findMany({
      // SA-070(b) Hazard 1: `correctsEntryId != null` excludes a B681 correction row — typed
      // like the row it corrects (net 0, qty 0, unitBasisQty a delta) — from EVER being read as
      // "the credited line's own live SALE row". Included here it would still skew `live.unitBasis`
      // (used below for the pieces-per-line-unit ratio) even though it never moves live.net/qty.
      // It is NOT excluded from `lineRows` below — the remaining-balance cap (`saleByLine`) must
      // still fold in its real net/qty/unitBasis contribution.
      where: {
        entryType: "SALE",
        correctsEntryId: null,
        ...(creditedOrderItemIds.length > 0
          ? {
              OR: [
                { invoiceItemId: { in: invoiceItemIds } },
                { orderItemId: { in: creditedOrderItemIds } },
              ],
            }
          : { invoiceItemId: { in: invoiceItemIds } }),
      },
      select: {
        invoiceItemId: true,
        createdAt: true,
        netSales: true,
        // B661: both quantity axes of THIS credited line's own SALE rows — the pieces-per-line-unit
        // ratio is taken from here, not from the order line's aggregate (see below).
        qty: true,
        unitBasisQty: true,
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
        qty: number;
        unitBasis: number;
        orderId: string | null;
        orderItemId: string | null;
        invoiceId: string | null;
        trackedSubcategoryId: string | null;
        /** The invoice item id the SALE rows sit under (differs from the credited item's after a rebuild). */
        saleInvoiceItemId: string | null;
      }
    >();
    type LiveSale = typeof liveSaleByItem extends Map<string, infer V> ? V : never;
    const addSale = (m: Map<string, LiveSale>, k: string, s: any) => {
      const cur = m.get(k) ?? {
        net: 0,
        qty: 0,
        unitBasis: 0,
        orderId: s.orderId ?? null,
        orderItemId: s.orderItemId ?? null,
        invoiceId: s.invoiceId ?? null,
        trackedSubcategoryId: s.trackedSubcategoryId ?? null,
        saleInvoiceItemId: s.invoiceItemId ?? null,
      };
      cur.net += Number(s.netSales);
      cur.qty += Number(s.qty);
      cur.unitBasis += Number(s.unitBasisQty);
      m.set(k, cur);
    };
    for (const s of liveSaleRows) addSale(liveSaleByItem, s.invoiceItemId ?? "", s);
    // SA-789 F1: a credited item no SALE row points at (re-created since the sale) matches its ORDER
    // LINE's SALE rows instead. Several generations of rows can share the order line: the figures
    // (pieces-per-unit ratio) come from the NEWEST generation (one invoice item id), never an aggregate.
    const unmatchedCredited: any[] = [];
    for (const it of items) {
      const key = it.invoiceItemId ?? "";
      if (!key || liveSaleByItem.has(key)) continue;
      const credited = creditedItems.find((c: any) => c.id === key);
      const orderItemId = credited?.orderItemId ?? null;
      const byGeneration = new Map<string, any[]>();
      for (const r of liveSaleRows) {
        // SA-835: the same order line AND the same invoice as the credited item.
        if (!orderItemId || r.orderItemId !== orderItemId || r.invoiceId !== credited?.invoiceId) {
          continue;
        }
        byGeneration.set(r.invoiceItemId ?? "", [
          ...(byGeneration.get(r.invoiceItemId ?? "") ?? []),
          r,
        ]);
      }
      if (byGeneration.size === 0) {
        unmatchedCredited.push(it);
        continue;
      }
      const newest = [...byGeneration.values()].sort((x, y) => {
        const tx = Math.max(...x.map((r: any) => new Date(r.createdAt ?? 0).getTime()));
        const ty = Math.max(...y.map((r: any) => new Date(r.createdAt ?? 0).getTime()));
        // Ties break on the invoice item id so the pick is deterministic.
        return ty - tx || String(y[0].invoiceItemId).localeCompare(String(x[0].invoiceItemId));
      })[0];
      for (const r of newest) addSale(liveSaleByItem, key, r);
    }
    await this.reportUnmatchedCredits(
      db,
      creditNoteId,
      unmatchedCredited,
      creditedItems,
      liveSaleRows,
    );

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
        unitBasisQty: true,
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
    type LineBag = { net: number; qty: number; unitBasis: number; tax: number };
    const emptyBag = (): LineBag => ({ net: 0, qty: 0, unitBasis: 0, tax: 0 });
    const saleByLine = new Map<string, LineBag>();
    const revByLine = new Map<string, LineBag>();
    for (const r of lineRows) {
      const lk = lineKeyOf(r);
      const bag = r.entryType === "SALE" ? saleByLine : revByLine;
      const cur = bag.get(lk) ?? emptyBag();
      cur.net += Number(r.netSales);
      cur.qty += Number(r.qty);
      cur.unitBasis += Number(r.unitBasisQty);
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
      const sale = saleByLine.get(lk) ?? emptyBag();
      if (sale.net <= 0) continue;
      const already = revByLine.get(lk) ?? emptyBag();
      // Remaining capacity to reverse for the ORDER LINE (signed, negative). `sale.*`
      // is the line's gross SALE, `already.*` (<= 0) folds in the reconcile re-sync
      // reversals that offset the pre-reconcile SALE rows, so this nets to the current
      // un-reversed balance.
      const remNet = -sale.net - already.net;
      const remQty = -sale.qty - already.qty;
      // B661: the SALE row's `unitBasisQty` is a PIECE count, while `qty` (and a CreditNoteItem's qty)
      // is in the INVOICE LINE's own unit — boxes for a box-unaware line. The two axes are tracked
      // separately and each is closed against its own remaining, or a full credit of a 5-box pack-12
      // line books -5 against a SALE of 60 and strands 55 phantom pieces on the regulated filing.
      const remUnitBasis = -sale.unitBasis - already.unitBasis;
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
      // The piece axis follows a pieces-per-line-unit ratio taken from the CREDITED LINE's OWN live SALE
      // rows (`live`), never the live product and never the ORDER LINE's aggregate. The aggregate spans
      // every SALE row of the line, including pre-reconcile rows already offset by re-sync reversals, so
      // if the product was repacked between the original write and a reconcile it is a weighted average
      // of two different packs — which books the right total but attributes pieces to the wrong FILING
      // PERIOD when partials straddle a boundary. `reverseReturnEntries` pro-rates off the live row's own
      // ratio for the same reason; this keeps the two paths consistent.
      //
      // A closing credit books the EXACT remaining pieces, mirroring how net/qty/tax close, so repeated
      // partials can never leave a residue — including a residue left by a pre-fix credit note. A
      // degenerate SALE (qty 0) has no ratio to scale by, so the line-unit value is carried through
      // unchanged — the pre-B661 behaviour.
      let unitBasis = live.qty !== 0 ? qty * (live.unitBasis / live.qty) : qty;
      if (closes) unitBasis = remUnitBasis;
      else if (unitBasis < remUnitBasis) unitBasis = remUnitBasis;
      const bookedNet = roundMoney(net);
      const bookedQty = round3(qty);
      const bookedUnitBasis = round3(unitBasis);
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
        // SA-835 MUST-2: stamped with the id the matched SALE rows sit under, so a later invoice void
        // (which nets by invoiceItemId) nets this reversal against its sale.
        invoiceItemId: live.saleInvoiceItemId ?? it.invoiceItemId,
        creditNoteId,
        qty: bookedQty,
        unitBasisQty: bookedUnitBasis,
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
        unitBasis: already.unitBasis + bookedUnitBasis,
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
