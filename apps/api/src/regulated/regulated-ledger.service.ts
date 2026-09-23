import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  roundMoney,
  regulatedUnitBasis,
  classifySaleAxis,
  type SaleAxisLine,
  type SaleAxisCorrection,
  type SaleAxisState,
} from "@routeflow/pricing";
import { periodBucketOf } from "./period";

/** Round a quantity to 3 decimals (matches the Decimal(12,3) ledger columns). */
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * One regulated invoice line, as seen at invoice-creation time. B661: the caller passes the
 * line's own STORED SHAPE (never a pre-computed unit basis — see `writeSaleEntries`, which is
 * the ONLY place `unitBasisQty` is derived, via `regulatedUnitBasis`). `qty` stays the line's own
 * qty — it becomes the ledger row's `qty`, which reconciles to the invoice line — and is no
 * longer read as an input to the row's `unitBasisQty`.
 */
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
   * `OrderItem.qty` (the identity conversion `returns-pieces.util.ts`'s `standardReturnPieces`
   * documents) — the LINE's OWN unit, boxes for a box-unaware line, never pieces despite that
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
   * B681/SA-067(2): the line shape `classifySaleAxis` needs for one SALE row — its OWN stored
   * boxes/pieces/unitLabel/unitsPerBox and productId, read from the InvoiceItem the row still
   * points at, or the OrderItem when the invoice item has since rotated away (a delivered-basis
   * reconcile deletes and recreates InvoiceItems under fresh ids, per `lineKeyOfSale` above).
   * `line: null` when neither resolves — "a row with NO readable line parks too" (SA-067(2)).
   */
  private async loadSaleLineShapes(
    db: any,
    sales: Array<{ id: string; invoiceItemId: string | null; orderItemId: string | null }>,
  ): Promise<Map<string, { line: SaleAxisLine | null; productId: string | null }>> {
    const invoiceItemIds = [
      ...new Set(sales.map((s) => s.invoiceItemId).filter(Boolean)),
    ] as string[];
    const orderItemIds = [...new Set(sales.map((s) => s.orderItemId).filter(Boolean))] as string[];
    const [invoiceItems, orderItems] = await Promise.all([
      invoiceItemIds.length > 0
        ? db.invoiceItem.findMany({
            where: { id: { in: invoiceItemIds } },
            select: {
              id: true,
              boxes: true,
              pieces: true,
              unitLabel: true,
              unitsPerBox: true,
              productId: true,
            },
          })
        : [],
      orderItemIds.length > 0
        ? db.orderItem.findMany({
            where: { id: { in: orderItemIds } },
            select: {
              id: true,
              boxes: true,
              pieces: true,
              unitLabel: true,
              unitsPerBox: true,
              productId: true,
            },
          })
        : [],
    ]);
    const byInvoiceItem = new Map<string, any>(invoiceItems.map((i: any) => [i.id, i]));
    const byOrderItem = new Map<string, any>(orderItems.map((i: any) => [i.id, i]));
    const out = new Map<string, { line: SaleAxisLine | null; productId: string | null }>();
    for (const s of sales) {
      const shape =
        (s.invoiceItemId ? byInvoiceItem.get(s.invoiceItemId) : undefined) ??
        (s.orderItemId ? byOrderItem.get(s.orderItemId) : undefined) ??
        null;
      out.set(s.id, {
        line: shape
          ? {
              boxes: shape.boxes,
              pieces: shape.pieces,
              unitLabel: shape.unitLabel,
              unitsPerBox: shape.unitsPerBox,
            }
          : null,
        productId: shape?.productId ?? null,
      });
    }
    return out;
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
        { entryType: s.entryType, qty: s.qty, unitBasisQty: s.unitBasisQty },
        shape.line,
        ownCorrections,
        productPackNow,
      );
      if (verdict.state === "legacy" || verdict.state === "unknown") {
        await this.parkReturnReversal(db, {
          tenantId: s.tenantId,
          returnId,
          orderId: s.orderId ?? orderId,
          orderItemId: s.orderItemId ?? null,
          saleEntryId: s.id,
          returnedPieces: remaining,
          reason: verdict.reason,
          periodBucket: bucket,
        });
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
    let bookedNet = closesRow ? roundMoney(-netRem) : roundMoney(-Number(s.netSales) * frac);
    let bookedTax = closesRow ? roundMoney(-taxRem) : roundMoney(-Number(s.categoryTax) * frac);
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
    lineKeyOfSale: (s: any) => string;
    remQtyByLine: Map<string, number>;
    remUnitBasisByLine: Map<string, number>;
    remNetByLine: Map<string, number>;
    remTaxByLine: Map<string, number>;
  } | null> {
    // The order's SALE rows are the snapshot we reverse against.
    const sales = await db.regulatedSalesLedger.findMany({
      where: { orderId, entryType: "SALE" },
    });
    if (sales.length === 0) return null;

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
    const priorReversals = await db.regulatedSalesLedger.findMany({
      where: { invoiceItemId: { in: invoiceItemIds }, entryType: "REVERSAL" },
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
      lineKeyOfSale,
      remQtyByLine,
      remUnitBasisByLine,
      remNetByLine,
      remTaxByLine,
    };
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
      lineKeyOfSale,
      remQtyByLine,
      remUnitBasisByLine,
      remNetByLine,
      remTaxByLine,
    } = built;

    // SALE rows grouped by product (FIFO within a product). Only LIVE sale rows
    // (invoice item still present) are reversal targets; the per-line remaining
    // above already accounts for the pre-reconcile rows on the deleted items.
    // SA-070(b) Hazard 1: a `correctsEntryId != null` row is a units-only B681 correction
    // typed like the row it corrects (its own qty/net are 0, unitBasisQty is a delta) — it is
    // ALREADY folded into remQtyByLine/remUnitBasisByLine/etc above (it's still in `sales`), but
    // must never be iterated here as a candidate to reverse against: on the PIECES axis it would
    // consume returned pieces against a zero-net row and book a reversal with a unit basis but no
    // money.
    const salesByProduct = new Map<string, any[]>();
    for (const s of sales) {
      if (s.correctsEntryId != null) continue;
      const pid = productByItem.get(s.invoiceItemId);
      if (!pid) continue;
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
        ? await this.loadSaleLineShapes(db, candidateSales)
        : new Map<string, { line: SaleAxisLine | null; productId: string | null }>();
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

    for (const [productId, returnedQtyRaw] of returnedByProduct.entries()) {
      let remaining = Number(returnedQtyRaw);
      if (!(remaining > 0)) continue;
      for (const s of salesByProduct.get(productId) ?? []) {
        if (remaining <= 0) break;
        const chunk = await this.bookReversalChunk({
          db,
          s,
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
        remaining = chunk.remaining;
        if (chunk.parked) break;
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
    // B681/SA-067(4): a return this guard parked (because its sale row's box/piece axis
    // couldn't be classified) leaves a RegulatedLedgerParkedReversal row blocking its period's
    // filing. Without this, cancelling that return before the park is ever resolved leaves the
    // row behind forever — deleted here, not resolved, because the return itself is undone, so
    // there is nothing left to resolve it against. Only this return's UNRESOLVED rows: a row
    // already resolved (resolvedAt set) recorded a real filing decision and must survive.
    await db.regulatedLedgerParkedReversal.deleteMany({ where: { returnId, resolvedAt: null } });
  }

  /**
   * SA-089 — B660: the operator resolution of ONE parked reversal row. Lives here (not a
   * separate injectable) because both `buildLineRemainingBalances` and `bookReversalChunk`
   * are private to this class — SA-090's own note. `ParkedReversalResolutionService`
   * (returns module) is the thin claim-first/audit wrapper that calls this; this method does
   * no claiming and no auditing, only the classify/correct/book money math, so it can be
   * called from inside the wrapper's own `tenantTransaction`.
   *
   * WHICH PACK (SA-089 §1): re-runs `classifySaleAxis` with the sale row's OWN line shape,
   * `unitsPerBox` REPLACED by the operator-supplied pack (never the line's own stale/absent
   * snapshot, never the live product) — a line with none resolved at all (deleted invoice
   * item, orphaned order item) uses the supplied pack as the WHOLE shape. `piece-axis` books
   * directly. `legacy` (box axis — the defect) appends ONE correction row first (SALE-typed,
   * `correctsEntryId` the sale row, `unitBasisQty` delta `+qty*(pack-1)`) so the SALE's basis
   * is fixed for every later reader and the classifier answers piece-axis from then on
   * (never re-parks — SA-070 hazard 2). `unknown` after the pack refuses outright — nothing
   * is written, the row stays parked.
   *
   * REMAINING CHANGED SINCE PARKING (SA-089 §2): `buildLineRemainingBalances` is called
   * FRESH here, never the parked row's own stale `returnedPieces` denominator — later
   * returns/credits/corrections are folded in automatically. `bookReversalChunk` (the SAME
   * booker the live reversal path uses, called with a single-row candidate set) caps the
   * booking at the line's current remaining and reports whatever it actually booked; a
   * capped booking is not an error.
   *
   * FULLY REVERSED NOW (SA-089 §3): `bookReversalChunk` itself pushes nothing to `rows` when
   * the line's remaining is already exhausted — that IS the close case, detected here as
   * `rows.length === 0`. No zero REVERSAL row is ever written for it.
   *
   * ONE-WAY (SA-089 §4): this method makes no resolved/claim state of its own — the wrapper
   * stamps `resolvedAt`/`unitsPerBoxSupplied` under the SAME transaction as the DB writes
   * this method makes, so a caller that rolls back the transaction rolls back the correction
   * row and the REVERSAL row together with the claim.
   */
  async resolveParkedReversal(
    db: any,
    parked: {
      returnId: string;
      orderId: string;
      orderItemId: string | null;
      saleEntryId: string;
      returnedPieces: number;
    },
    pack: number,
  ): Promise<{
    outcome: "booked" | "closed" | "unresolvable";
    correctionEntryId: string | null;
    resolvedEntryId: string | null;
    bookedPieces: number;
    bookedQty: number;
    bookedNet: number;
    bookedTax: number;
    verdictAfter: SaleAxisState | null;
    unresolvableReason: string | null;
  }> {
    const unresolvable = (reason: string, correctionEntryId: string | null = null) => ({
      outcome: "unresolvable" as const,
      correctionEntryId,
      resolvedEntryId: null,
      bookedPieces: 0,
      bookedQty: 0,
      bookedNet: 0,
      bookedTax: 0,
      verdictAfter: null,
      unresolvableReason: reason,
    });

    const saleRow = await db.regulatedSalesLedger.findFirst({
      where: { id: parked.saleEntryId },
    });
    // The sale row should never actually be missing (it is never deleted elsewhere) — treated
    // as unresolvable rather than silently booking against nothing if it somehow is.
    if (!saleRow) return unresolvable("the sale row no longer exists");

    const shapes = await this.loadSaleLineShapes(db, [saleRow]);
    const shape = shapes.get(saleRow.id) ?? { line: null, productId: null };
    const lineWithSuppliedPack: SaleAxisLine = shape.line
      ? { ...shape.line, unitsPerBox: pack }
      : { boxes: null, pieces: null, unitLabel: null, unitsPerBox: pack };

    let correctionsBySaleId = await this.loadCorrectionsBySaleId(db, [saleRow.id]);
    const verdict = classifySaleAxis(
      { entryType: saleRow.entryType, qty: saleRow.qty, unitBasisQty: saleRow.unitBasisQty },
      lineWithSuppliedPack,
      correctionsBySaleId.get(saleRow.id) ?? [],
      pack,
    );
    if (verdict.state === "unknown") return unresolvable(verdict.reason);

    let correctionEntryId: string | null = null;
    if (verdict.state === "legacy") {
      const qty = Number(saleRow.qty);
      const correction = await db.regulatedSalesLedger.create({
        data: {
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
          soldAt: new Date(),
          qty: 0,
          unitBasisQty: qty * (pack - 1),
          netSales: 0,
          categoryTax: 0,
          periodBucket: periodBucketOf(new Date()),
        },
      });
      correctionEntryId = correction.id;
      // Refresh so bookReversalChunk's OWN classify call below folds the new row in and
      // answers piece-axis — it must never re-park what was just corrected.
      correctionsBySaleId = await this.loadCorrectionsBySaleId(db, [saleRow.id]);
    }

    const built = await this.buildLineRemainingBalances(db, parked.orderId);
    if (!built) return unresolvable("no SALE rows remain on this order", correctionEntryId);
    const { lineKeyOfSale, remQtyByLine, remUnitBasisByLine, remNetByLine, remTaxByLine } = built;

    const now = new Date();
    const bucket = periodBucketOf(now);
    const rows: any[] = [];
    const chunk = await this.bookReversalChunk({
      db,
      s: saleRow,
      remaining: parked.returnedPieces,
      returnId: parked.returnId,
      orderId: parked.orderId,
      returnedUnit: "PIECES",
      bucket,
      now,
      lineKeyOfSale,
      nativeRemByLine: remUnitBasisByLine,
      remQtyByLine,
      remUnitBasisByLine,
      remNetByLine,
      remTaxByLine,
      lineShapeBySaleId: new Map([
        [saleRow.id, { line: lineWithSuppliedPack, productId: shape.productId }],
      ]),
      correctionsBySaleId,
      packNowByProduct: new Map(shape.productId ? [[shape.productId, pack]] : []),
      rows,
    });

    // Defensive: our own pre-classify above already ruled out "unknown", so
    // bookReversalChunk's internal re-classify (same data, now with the correction folded
    // in when one was written) should never disagree and park again — if it somehow does,
    // treat it as unresolvable rather than silently reporting success.
    if (chunk.parked)
      return unresolvable("classification disagreed after correction", correctionEntryId);

    if (rows.length === 0) {
      return {
        outcome: "closed",
        correctionEntryId,
        resolvedEntryId: null,
        bookedPieces: 0,
        bookedQty: 0,
        bookedNet: 0,
        bookedTax: 0,
        verdictAfter: verdict.state,
        unresolvableReason: null,
      };
    }

    const created = await db.regulatedSalesLedger.create({ data: rows[0] });
    return {
      outcome: "booked",
      correctionEntryId,
      resolvedEntryId: created.id,
      bookedPieces: -Number(created.unitBasisQty),
      bookedQty: -Number(created.qty),
      bookedNet: -Number(created.netSales),
      bookedTax: -Number(created.categoryTax),
      verdictAfter: verdict.state,
      unresolvableReason: null,
    };
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
      // SA-070(b) Hazard 1: `correctsEntryId != null` excludes a B681 correction row — typed
      // like the row it corrects (net 0, qty 0, unitBasisQty a delta) — from EVER being read as
      // "the credited line's own live SALE row". Included here it would still skew `live.unitBasis`
      // (used below for the pieces-per-line-unit ratio) even though it never moves live.net/qty.
      // It is NOT excluded from `lineRows` below — the remaining-balance cap (`saleByLine`) must
      // still fold in its real net/qty/unitBasis contribution.
      where: { invoiceItemId: { in: invoiceItemIds }, entryType: "SALE", correctsEntryId: null },
      select: {
        invoiceItemId: true,
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
      }
    >();
    for (const s of liveSaleRows) {
      const k = s.invoiceItemId ?? "";
      const cur = liveSaleByItem.get(k) ?? {
        net: 0,
        qty: 0,
        unitBasis: 0,
        orderId: s.orderId ?? null,
        orderItemId: s.orderItemId ?? null,
        invoiceId: s.invoiceId ?? null,
        trackedSubcategoryId: s.trackedSubcategoryId ?? null,
      };
      cur.net += Number(s.netSales);
      cur.qty += Number(s.qty);
      cur.unitBasis += Number(s.unitBasisQty);
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
        invoiceItemId: it.invoiceItemId,
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
