import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { monthRange } from "./period";

/**
 * B297 PR5 (SA-088 D4, SA-734r2 B6): what a LOCKED `RegulatedFiling` means for writes.
 *
 * A LOCKED filing closes the (tenant, category, period) triple. Two guards, defence in depth:
 *  (a) EDIT GUARD (user-facing, `assertSalesNotLockedForEdit`): before a money-bearing change to a regulated
 *      line whose SALE rows are booked into a locked period, refuse with 409 FILED_PERIOD_LOCKED naming the
 *      filing and the period;
 *  (b) LEDGER GUARD (the last line, `assertLedgerRowsNotLocked`): the ledger writers refuse any row whose
 *      `periodBucket` is covered by a LOCKED filing for the row's category (409 LEDGER_PERIOD_LOCKED, no rows).
 *      Under never-backdate a row books into the CURRENT bucket and a filing cannot lock before its period
 *      ends, so this can only fire across a bucket boundary: it exists to make the invariant structural.
 * Returns and credit notes against a locked-period sale are NOT blocked at the edit guard: a return is a new
 * event booked today, and the locked period's SUM is untouched.
 */
export interface LockedFilingRow {
  id: string;
  trackedCategoryId: string;
  periodKey: string;
  periodStart: Date;
  periodEnd: Date;
  status: string;
}

export interface BucketRef {
  trackedCategoryId: string;
  periodBucket: string;
}

type LockDb = {
  regulatedFiling?: { findMany(args: unknown): Promise<any[]> };
  regulatedSalesLedger?: { findMany(args: unknown): Promise<any[]> };
};

/**
 * The LOCKED filings that cover each given (category, periodBucket) pair. A filing covers a bucket when the
 * bucket's month starts inside its [periodStart, periodEnd). A client without a filings model (a unit-test
 * stub) covers nothing.
 */
export async function lockedFilingsCovering(
  db: LockDb,
  refs: BucketRef[],
): Promise<Array<{ filing: LockedFilingRow; trackedCategoryId: string; periodBucket: string }>> {
  if (refs.length === 0 || !db.regulatedFiling?.findMany) return [];
  const categoryIds = [...new Set(refs.map((r) => r.trackedCategoryId))];
  const filings: LockedFilingRow[] = await db.regulatedFiling.findMany({
    where: { trackedCategoryId: { in: categoryIds }, status: "LOCKED" },
  });
  if (filings.length === 0) return [];
  const out: Array<{ filing: LockedFilingRow; trackedCategoryId: string; periodBucket: string }> =
    [];
  for (const ref of refs) {
    const from = monthRange(ref.periodBucket).from.getTime();
    for (const f of filings) {
      if (
        f.trackedCategoryId === ref.trackedCategoryId &&
        f.periodStart.getTime() <= from &&
        from < f.periodEnd.getTime()
      )
        out.push({
          filing: f,
          trackedCategoryId: ref.trackedCategoryId,
          periodBucket: ref.periodBucket,
        });
    }
  }
  return out;
}

/** (b) the ledger guard: throws LEDGER_PERIOD_LOCKED when any row would book into a locked period. */
export async function assertLedgerRowsNotLocked(db: LockDb, rows: BucketRef[]): Promise<void> {
  const unique = [
    ...new Map(rows.map((r) => [`${r.trackedCategoryId}|${r.periodBucket}`, r])).values(),
  ];
  const hit = (await lockedFilingsCovering(db, unique))[0];
  if (!hit) return;
  throw new ConflictException({
    code: API_ERROR_CODES.LEDGER_PERIOD_LOCKED,
    message: `The ${hit.filing.periodKey} filing for this category is locked: the regulated ledger cannot take a row for ${hit.periodBucket}.`,
    filingId: hit.filing.id,
    periodKey: hit.filing.periodKey,
  });
}

/**
 * (a) the edit guard: refuse when any SALE row of the given order or invoice sits in a locked period. The
 * caller decides WHICH edits are money-bearing (a note or a delivery date never calls this).
 */
export async function assertSalesNotLockedForEdit(
  db: LockDb,
  where: { orderId?: string; invoiceId?: string },
): Promise<void> {
  // Cheap exit for the overwhelmingly common tenant: nothing is locked, so no ledger read at all.
  if (!db.regulatedFiling?.findMany || !db.regulatedSalesLedger?.findMany) return;
  const anyLocked = await db.regulatedFiling.findMany({ where: { status: "LOCKED" }, take: 1 });
  if (anyLocked.length === 0) return;
  const sales = await db.regulatedSalesLedger.findMany({
    where: { ...where, entryType: "SALE", correctsEntryId: null },
    select: { trackedCategoryId: true, periodBucket: true },
  });
  const hit = (await lockedFilingsCovering(db, sales as BucketRef[]))[0];
  if (!hit) return;
  throw new ConflictException({
    code: API_ERROR_CODES.FILED_PERIOD_LOCKED,
    message:
      `This change would move money in the ${hit.filing.periodKey} period, which is filed and locked. ` +
      `Record a return or a credit note instead (it books into the current period).`,
    filingId: hit.filing.id,
    periodKey: hit.filing.periodKey,
  });
}

/**
 * Is this order-edit payload MONEY-bearing for the edit guard? A replace-all, a new line, a substitute, a
 * strike-off, or any change to a quantity / split / unit / price is. A note, an override reason or a
 * substitution note alone is not: it proceeds (and, with the changed-only ledger re-sync, writes no ledger rows).
 */
export function isMoneyBearingEdit(dto: {
  replaceAll?: boolean | null;
  items?: Array<Record<string, unknown>> | null;
}): boolean {
  if (dto.replaceAll === true) return true;
  const moneyKeys = [
    "qty",
    "boxes",
    "pieces",
    "unitLabel",
    "unitPrice",
    "discount",
    "substituteProductId",
  ];
  return (dto.items ?? []).some(
    (i) =>
      !i.id || // a new line
      i.action === "CANCEL" ||
      i.action === "DELETE" ||
      moneyKeys.some((k) => i[k] !== undefined && i[k] !== null),
  );
}

/**
 * The order-edit guard in one call: refuse (409 FILED_PERIOD_LOCKED) a MONEY-bearing edit to an order whose
 * regulated SALE rows are booked into a LOCKED filing period. A note, an override reason or a delivery date
 * proceeds; a return or a credit note is not an edit and books today.
 */
export async function assertOrderEditNotLocked(
  db: LockDb,
  orderId: string,
  dto: Parameters<typeof isMoneyBearingEdit>[0],
): Promise<void> {
  if (isMoneyBearingEdit(dto)) await assertSalesNotLockedForEdit(db, { orderId });
}
