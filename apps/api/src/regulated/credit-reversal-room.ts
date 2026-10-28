/**
 * THE per-line remaining a credit note can still reverse on the regulated ledger (SA-1042 A-4, one predicate).
 *
 * `RegulatedLedgerService.reverseCreditNoteEntries` clamps every credit item to this remaining when it books the
 * REVERSAL; `CreditNotesService` binds a typed row to the SAME figure before the note is written, so the money and
 * the filing can no longer disagree about a line the ledger has nothing left to reverse. Moved verbatim out of
 * `reverseCreditNoteEntries` (SA-789 F1, SA-835, SA-070(b) Hazard 1, B297 row 341, B661): credited item -> its order
 * line -> the live SALE rows -> per-ORDER-LINE SALE and REVERSAL bags.
 */
import { roundMoney } from "@routeflow/pricing";
import { deadSaleIdsOf } from "./regulated-ledger.service";

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** The ledger's own tolerance on the money axis (`remNet >= -0.005` = nothing left). */
export const ROOM_EPS = 0.005;

export type LineBag = { net: number; qty: number; unitBasis: number; tax: number };
export const emptyBag = (): LineBag => ({ net: 0, qty: 0, unitBasis: 0, tax: 0 });

/** The credit item fields the room reads (a stored CreditNoteItem, or a row about to be written). */
export interface RoomItem {
  invoiceItemId: string | null;
  trackedCategoryId: string | null;
}

export interface LiveSale {
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

export interface CreditReversalRoom {
  creditedItems: any[];
  liveSaleRows: any[];
  liveSaleByItem: Map<string, LiveSale>;
  /** Credited items no SALE row points at, even through their order line (the caller reports them). */
  unmatchedCredited: any[];
  deadSaleIds: Set<string>;
  saleByLine: Map<string, LineBag>;
  /** Everything already reversed per order line; the caller accumulates what it books here. */
  revByLine: Map<string, LineBag>;
}

/** What one credit item can still reverse: the live key it books under and the line's remaining (signed, <= 0). */
export interface ItemRoom {
  live: LiveSale;
  meta: {
    orderId: string | null;
    orderItemId: string | null;
    invoiceId: string | null;
    trackedSubcategoryId: string | null;
    qty: number;
    unitBasis: number;
  };
  /** The order line the remaining is keyed on (the stable id; the invoice item id for a freeform line). */
  lineKey: string;
  already: LineBag;
  remNet: number;
  remQty: number;
  remUnitBasis: number;
  remTax: number;
}

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

/**
 * Reads the ledger state for the credit `items` (each with a tracked category). `null` when none names an invoice
 * item. `excludeCreditNoteId`: a reissue's dry run leaves the note about to be voided out, so the room counts exactly
 * what its void frees.
 */
export async function loadCreditReversalRoom(
  db: any,
  items: RoomItem[],
  opts: {
    excludeCreditNoteId?: string;
    /** Runs right after the unmatched-item pass, BEFORE the line rows are read (the ledger raises its notice here). */
    onUnmatched?: (unmatched: any[], creditedItems: any[], liveSaleRows: any[]) => Promise<void>;
  } = {},
): Promise<CreditReversalRoom | null> {
  const invoiceItemIds = [
    ...new Set(items.map((it) => it.invoiceItemId).filter(Boolean)),
  ] as string[];
  if (invoiceItemIds.length === 0) return null;

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
    // deterministic read order: the live-key choice and the oldest-first offset rule never depend on the planner
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      // `id` is what deadSaleIdsOf / the live-row filter key on: a SALE read without it can never be named dead
      id: true,
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
      // B297 row 341: which booked line (category / subcategory / order line) each SALE row is.
      trackedCategoryId: true,
    },
  });
  const liveSaleByItem = new Map<string, LiveSale>();
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
  await opts.onUnmatched?.(unmatchedCredited, creditedItems, liveSaleRows);

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
  const allLineRows: any[] = await db.regulatedSalesLedger.findMany({
    where: {
      entryType: { in: ["SALE", "REVERSAL"] },
      OR: [
        ...(orderLineIds.length > 0 ? [{ orderItemId: { in: orderLineIds } }] : []),
        { invoiceItemId: { in: invoiceItemIds } },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      // deadSaleIdsOf needs the row's identity, its time and whether it is a units-only correction
      id: true,
      createdAt: true,
      correctsEntryId: true,
      entryType: true,
      invoiceItemId: true,
      orderItemId: true,
      trackedCategoryId: true,
      trackedSubcategoryId: true,
      returnId: true,
      creditNoteId: true,
      netSales: true,
      qty: true,
      unitBasisQty: true,
      categoryTax: true,
    },
  });
  const lineRows = opts.excludeCreditNoteId
    ? allLineRows.filter((r: any) => r.creditNoteId !== opts.excludeCreditNoteId)
    : allLineRows;
  // B297 row 341: base SALEs that are not a live target (a re-filed line's dead sale, or one offset in place).
  const deadSaleIds = deadSaleIdsOf(lineRows);
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
  return {
    creditedItems,
    liveSaleRows,
    liveSaleByItem,
    unmatchedCredited,
    deadSaleIds,
    saleByLine,
    revByLine,
  };
}

/**
 * What `it` can still reverse, or `null` when the ledger never reverses it (no live SALE for the item, or its order
 * line sold nothing): the SALE-existence guard, so no naked reversal. The caller applies the `remNet >= -0.005`
 * "fully reversed" skip and keeps `room.revByLine` current as it books.
 */
export function creditItemRoom(room: CreditReversalRoom, it: RoomItem): ItemRoom | null {
  const live = room.liveSaleByItem.get(it.invoiceItemId ?? "");
  if (!live || live.net <= 0) return null; // SALE-existence guard — no naked reversal.
  // B297 row 341: the subcategory / order line / invoice the reversal carries, and the pieces-per-unit
  // ratio, come from the line's LIVE booked key (the newest base SALE of the credited category that is not
  // dead), never from whichever SALE of the item an unordered read returned first or from the dead sale
  // blended in. A LOCAL, so a second credit item on the same invoice item starts from `live` again.
  const liveRows = room.liveSaleRows.filter(
    (s: any) =>
      s.invoiceItemId === it.invoiceItemId &&
      !room.deadSaleIds.has(s.id) &&
      (s.trackedCategoryId == null || s.trackedCategoryId === it.trackedCategoryId),
  );
  const metaRow = [...liveRows].sort(
    (a: any, b: any) => +new Date(b.createdAt ?? 0) - +new Date(a.createdAt ?? 0),
  )[0];
  const meta = metaRow
    ? {
        orderId: metaRow.orderId ?? null,
        orderItemId: metaRow.orderItemId ?? null,
        invoiceId: metaRow.invoiceId ?? null,
        trackedSubcategoryId: metaRow.trackedSubcategoryId ?? null,
        qty: liveRows.reduce((n: number, r: any) => n + Number(r.qty), 0),
        unitBasis: liveRows.reduce((n: number, r: any) => n + Number(r.unitBasisQty), 0),
      }
    : {
        orderId: live.orderId,
        orderItemId: live.orderItemId,
        invoiceId: live.invoiceId,
        trackedSubcategoryId: live.trackedSubcategoryId,
        qty: live.qty,
        unitBasis: live.unitBasis,
      };
  const lineKey = meta.orderItemId ?? it.invoiceItemId ?? "";
  const sale = room.saleByLine.get(lineKey) ?? emptyBag();
  if (sale.net <= 0) return null;
  const already = room.revByLine.get(lineKey) ?? emptyBag();
  // Remaining capacity to reverse for the ORDER LINE (signed, negative). `sale.*`
  // is the line's gross SALE, `already.*` (<= 0) folds in the reconcile re-sync
  // reversals that offset the pre-reconcile SALE rows, so this nets to the current
  // un-reversed balance.
  // B661: the SALE row's `unitBasisQty` is a PIECE count, while `qty` (and a CreditNoteItem's qty)
  // is in the INVOICE LINE's own unit — boxes for a box-unaware line. The two axes are tracked
  // separately and each is closed against its own remaining, or a full credit of a 5-box pack-12
  // line books -5 against a SALE of 60 and strands 55 phantom pieces on the regulated filing.
  return {
    live,
    meta,
    lineKey,
    already,
    remNet: -sale.net - already.net,
    remQty: -sale.qty - already.qty,
    remUnitBasis: -sale.unitBasis - already.unitBasis,
    remTax: -sale.tax - already.tax,
  };
}

/** A typed credit row on a regulated line, as the credit-note item builder holds it before anything is written. */
export interface CreditRowInput extends RoomItem {
  amount: number;
  qty: number;
}

export interface CreditRoomRefusal {
  invoiceItemId: string | null;
  requestedAmount: number;
  remainingAmount: number;
  requestedQty: number;
  remainingQty: number;
}

/**
 * SA-1042 A-4: the first typed row that asks for more than the ledger can still reverse on its order line, or `null`.
 * Compares the row's amount and qty (typed or derived) to the SAME remaining `reverseCreditNoteEntries` clamps to, past the
 * same 0.005, and folds each accepted row into a local copy of the line's reversed bag so a second row on one order line
 * sees the reduced remaining. Not bound (`creditItemRoom` returns null): a line with no live SALE row, and any row without a
 * tracked category (non-regulated lines, SA-628 return-refund rows). Reads only: no notice, no write.
 */
export async function creditRoomRefusal(
  db: any,
  rows: CreditRowInput[],
  opts: { excludeCreditNoteId?: string } = {},
): Promise<CreditRoomRefusal | null> {
  const regulated = rows.filter((r) => r.trackedCategoryId);
  if (regulated.length === 0) return null;
  const room = await loadCreditReversalRoom(db, regulated, opts);
  if (!room) return null;
  for (const row of regulated) {
    const left = creditItemRoom(room, row);
    if (!left) continue;
    // a fully reversed line (`remNet >= -0.005`) has nothing left: any row on it is past the tolerance
    const remainingAmount = Math.max(0, roundMoney(-left.remNet));
    const remainingQty = Math.max(0, round3(-left.remQty));
    if (row.amount > remainingAmount + ROOM_EPS || row.qty > remainingQty + ROOM_EPS) {
      return {
        invoiceItemId: row.invoiceItemId,
        requestedAmount: roundMoney(row.amount),
        remainingAmount,
        requestedQty: round3(row.qty),
        remainingQty,
      };
    }
    room.revByLine.set(left.lineKey, {
      ...left.already,
      net: left.already.net - Math.min(row.amount, remainingAmount),
      qty: left.already.qty - Math.min(row.qty, remainingQty),
    });
  }
  return null;
}
