/**
 * SA-1042 A-4 G5: READ-ONLY census of OLD typed credit rows (an owner-run report; it never feeds a filing figure).
 *
 * Counts the credit notes whose REVERSAL rows booked LESS levy than their typed items stored, over the items the ledger can
 * actually reverse: an item counts only when it has a LIVE SALE row, found by `loadCreditReversalRoom` (the loader
 * `reverseCreditNoteEntries` and the A-4 bind both read) and not named dead by `deadSaleIdsOf` (a SALE a re-sync or void
 * offset, or whose key is square). Items with no live SALE (SA-628 return-refund rows, lines that never booked, a line whose only
 * SALE is dead) are reported apart and never read as a mismatch: the ledger reverses nothing for them.
 *
 * `apps/api/scripts/report-a4-credit-reversal-census.mjs` is the thin runner (local database only, read-only session).
 */
import { loadCreditReversalRoom } from "./credit-reversal-room";

const TAX_EPS = 0.01;
const BATCH = 500;

export interface CreditReversalCensus {
  typedItems: number;
  notes: number;
  itemsWithLiveSale: number;
  itemsWithoutLiveSale: number;
  notesBookedLessTaxThanStored: number;
  sample: Array<{ creditNoteId: string; storedTax: number; bookedTax: number }>;
}

/** `tenantId` narrows the census to one tenant (the DB specs use it); omitted = every tenant. */
export async function censusOldTypedCredits(
  db: any,
  opts: { tenantId?: string } = {},
): Promise<CreditReversalCensus> {
  const items: Array<{
    creditNoteId: string;
    invoiceItemId: string | null;
    trackedCategoryId: string | null;
    categoryTax: unknown;
  }> = await db.creditNoteItem.findMany({
    where: {
      trackedCategoryId: { not: null },
      creditNote: { status: { not: "VOID" } },
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    },
    select: { creditNoteId: true, invoiceItemId: true, trackedCategoryId: true, categoryTax: true },
    orderBy: { id: "asc" },
  });

  const storedByNote = new Map<string, number>();
  let withLive = 0;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const room = await loadCreditReversalRoom(db, batch);
    for (const it of batch) {
      let live = false;
      if (room && it.invoiceItemId) {
        const orderItemId =
          room.creditedItems.find((c: any) => c.id === it.invoiceItemId)?.orderItemId ?? null;
        live = room.liveSaleRows.some(
          (s: any) =>
            !room.deadSaleIds.has(s.id) &&
            (s.trackedCategoryId == null || s.trackedCategoryId === it.trackedCategoryId) &&
            (s.invoiceItemId === it.invoiceItemId ||
              (orderItemId != null && s.orderItemId === orderItemId)),
        );
      }
      if (!live) continue;
      withLive += 1;
      storedByNote.set(
        it.creditNoteId,
        (storedByNote.get(it.creditNoteId) ?? 0) + Number(it.categoryTax),
      );
    }
  }

  const bookedByNote = new Map<string, number>();
  const noteIds = [...storedByNote.keys()];
  for (let i = 0; i < noteIds.length; i += BATCH) {
    const grouped: Array<{ creditNoteId: string | null; _sum: { categoryTax: unknown } }> =
      await db.regulatedSalesLedger.groupBy({
        by: ["creditNoteId"],
        where: { entryType: "REVERSAL", creditNoteId: { in: noteIds.slice(i, i + BATCH) } },
        _sum: { categoryTax: true },
      });
    for (const g of grouped) {
      if (g.creditNoteId) bookedByNote.set(g.creditNoteId, -Number(g._sum.categoryTax ?? 0));
    }
  }

  const short = noteIds
    .map((creditNoteId) => ({
      creditNoteId,
      storedTax: storedByNote.get(creditNoteId) ?? 0,
      bookedTax: bookedByNote.get(creditNoteId) ?? 0,
    }))
    .filter((n) => n.bookedTax < n.storedTax - TAX_EPS)
    .sort((a, b) => b.storedTax - b.bookedTax - (a.storedTax - a.bookedTax));

  return {
    typedItems: items.length,
    notes: new Set(items.map((it) => it.creditNoteId)).size,
    itemsWithLiveSale: withLive,
    itemsWithoutLiveSale: items.length - withLive,
    notesBookedLessTaxThanStored: short.length,
    sample: short.slice(0, 5),
  };
}
