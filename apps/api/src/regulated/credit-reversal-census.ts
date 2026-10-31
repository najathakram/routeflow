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
import { CreditNoteStatus } from "@prisma/client";
import { loadCreditReversalRoom } from "./credit-reversal-room";

const TAX_EPS = 0.01;
const BATCH = 500;

/**
 * SA-1054 A-1: the denominators a zero needs. An empty database prints the same all-zero census as a real one with no old typed
 * rows, so the report carries plain counts that prove the database is live and cross-check the census from another table.
 * Counts only: no tenant, customer, name or id.
 *
 *   - `creditNotes` / `creditNotesByStatus`: every note (CreditNote has no type column). All 0 = the run proves nothing.
 *   - `notesWithItems` + `notesWithoutItems` = `creditNotes` (line-linked against lump); `creditNoteItems` = every item row.
 *   - `itemsOnRegulatedLine`: items on a non-VOID note whose invoice line carries a category, whatever the row stamped (the same
 *     non-VOID basis as `typedItems`). Above 0 with `typedItems` 0 = all of them are return rows, as designed.
 *   - `reversalsNamingCreditNote`: REVERSAL ledger rows naming a non-VOID credit note. Only a typed row writes one, from a
 *     different table than the census reads: above 0 with `typedItems` 0 = the census missed rows (stop, back to the SA).
 *   - `regulatedSaleRows`: SALE ledger rows. 0 = nothing to reverse, so a zero census is trivially true.
 */
export interface CreditReversalDenominators {
  creditNotes: number;
  creditNotesByStatus: Record<CreditNoteStatus, number>;
  notesWithItems: number;
  notesWithoutItems: number;
  creditNoteItems: number;
  itemsOnRegulatedLine: number;
  reversalsNamingCreditNote: number;
  regulatedSaleRows: number;
}

export interface CreditReversalCensus {
  typedItems: number;
  notes: number;
  itemsWithLiveSale: number;
  itemsWithoutLiveSale: number;
  notesBookedLessTaxThanStored: number;
  sample: Array<{ creditNoteId: string; storedTax: number; bookedTax: number }>;
  denominators: CreditReversalDenominators;
}

/** Plain read-only counts (SELECT / count / groupBy only). `tenantId` narrows every count to one tenant. */
export async function loadDenominators(
  db: any,
  opts: { tenantId?: string } = {},
): Promise<CreditReversalDenominators> {
  const tenantId = opts.tenantId ?? null;
  const tenantWhere = tenantId ? { tenantId } : {};
  // every status listed, zeros included: a missing key would read as "not counted", not as none
  const byStatus = Object.fromEntries(Object.values(CreditNoteStatus).map((s) => [s, 0])) as Record<
    CreditNoteStatus,
    number
  >;
  const grouped: Array<{ status: CreditNoteStatus; _count: { _all: number } }> =
    await db.creditNote.groupBy({ by: ["status"], where: tenantWhere, _count: { _all: true } });
  for (const g of grouped) byStatus[g.status] = g._count._all;
  const notes = Object.values(byStatus).reduce((n, c) => n + c, 0);
  // one after another: they share the census transaction's single connection
  const notesWithItems = await db.creditNote.count({
    where: { ...tenantWhere, items: { some: {} } },
  });
  const notesWithoutItems = await db.creditNote.count({
    where: { ...tenantWhere, items: { none: {} } },
  });
  const creditNoteItems = await db.creditNoteItem.count({ where: tenantWhere });
  const regulatedSaleRows = await db.regulatedSalesLedger.count({
    where: { ...tenantWhere, entryType: "SALE" },
  });
  // CreditNoteItem and the ledger carry no relation to InvoiceItem / CreditNote, so these two joins are plain SELECTs
  const [onRegulated] = await db.$queryRaw`
    SELECT COUNT(*)::int AS n
    FROM "CreditNoteItem" ci
    JOIN "CreditNote" c ON c."id" = ci."creditNoteId"
    JOIN "InvoiceItem" ii ON ii."id" = ci."invoiceItemId"
    WHERE c."status" <> 'VOID'
      AND ii."trackedCategoryId" IS NOT NULL
      AND (${tenantId}::text IS NULL OR ci."tenantId" = ${tenantId})`;
  const [reversals] = await db.$queryRaw`
    SELECT COUNT(*)::int AS n
    FROM "RegulatedSalesLedger" r
    JOIN "CreditNote" c ON c."id" = r."creditNoteId"
    WHERE r."entryType" = 'REVERSAL'
      AND c."status" <> 'VOID'
      AND (${tenantId}::text IS NULL OR r."tenantId" = ${tenantId})`;
  return {
    creditNotes: notes,
    creditNotesByStatus: byStatus,
    notesWithItems,
    notesWithoutItems,
    creditNoteItems,
    itemsOnRegulatedLine: Number(onRegulated?.n ?? 0),
    reversalsNamingCreditNote: Number(reversals?.n ?? 0),
    regulatedSaleRows,
  };
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
    denominators: await loadDenominators(db, opts),
  };
}
