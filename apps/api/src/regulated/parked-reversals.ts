import { ConflictException } from "@nestjs/common";
import type { RegulatedReport } from "./report-types";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * The FILING GATE's reader (Senior Architect ruling 2026-09-21). A return reversal the ledger could not book
 * (the sold line's pack is unknown) is PARKED in RegulatedLedgerParkedReversal (parked <=> resolvedAt IS NULL)
 * and is NOT in the period's figures until an operator resolves it. A period that still has one must not be
 * filed (prepareFiling refuses) and its report must say so first. Read through `db` = `prisma.forTenant()`.
 */

export interface ParkedReversalRow {
  id: string;
  returnId: string;
  orderId: string;
  orderItemId: string | null;
  saleEntryId: string;
  returnedPieces: number;
  reason: string;
  periodBucket: string;
  createdAt: Date;
  /** False when the SALE row it points at could not be found: the row then blocks EVERY category. */
  categoryResolved: boolean;
}

/**
 * The unresolved parked reversals that belong to `trackedCategoryId` in the given "YYYY-MM" buckets (the
 * RETURN's period bucket: where the reversal will book). The parked table has no category column: it is
 * resolved through `saleEntryId -> RegulatedSalesLedger.trackedCategoryId` (a scalar pointer, no FK). A row
 * whose sale entry cannot be found is UNRESOLVABLE and is returned for every category, never dropped.
 * Oldest first.
 */
export async function listParkedReversals(
  db: any,
  params: { trackedCategoryId: string; buckets: string[] },
): Promise<ParkedReversalRow[]> {
  const parked: any[] = await db.regulatedLedgerParkedReversal.findMany({
    where: { resolvedAt: null, periodBucket: { in: params.buckets } },
    orderBy: { createdAt: "asc" },
  });
  if (parked.length === 0) return [];
  const sales: any[] = await db.regulatedSalesLedger.findMany({
    where: { id: { in: [...new Set(parked.map((p) => p.saleEntryId))] } },
    select: { id: true, trackedCategoryId: true },
  });
  const categoryOfSale = new Map<string, string>(sales.map((s) => [s.id, s.trackedCategoryId]));
  return parked
    .filter((p) => {
      const cat = categoryOfSale.get(p.saleEntryId);
      return cat === undefined || cat === params.trackedCategoryId;
    })
    .map((p) => ({
      id: p.id,
      returnId: p.returnId,
      orderId: p.orderId,
      orderItemId: p.orderItemId ?? null,
      saleEntryId: p.saleEntryId,
      returnedPieces: Number(p.returnedPieces),
      reason: p.reason,
      periodBucket: p.periodBucket,
      createdAt: p.createdAt,
      categoryResolved: categoryOfSale.has(p.saleEntryId),
    }));
}

/**
 * A stock NOTE (never a gate): unresolved ReturnParkedRestock rows of this category's products created in
 * [from, to). Null when none. The restock waits for the same operator resolution as the ledger reversal.
 */
export async function parkedRestockNote(
  db: any,
  params: { trackedCategoryId: string; from: Date; to: Date },
): Promise<string | null> {
  const products: any[] = await db.product.findMany({
    where: { trackedCategoryId: params.trackedCategoryId },
    select: { id: true },
  });
  if (products.length === 0) return null;
  const count: number = await db.returnParkedRestock.count({
    where: {
      resolvedAt: null,
      createdAt: { gte: params.from, lt: params.to },
      productId: { in: products.map((p) => p.id) },
    },
  });
  return count > 0
    ? `${count} return restock(s) are parked (pack unknown): stock for these products has not been updated yet.`
    : null;
}

/** Refuses a filing while the period has an unresolved parked reversal (409, naming the count and the action). */
export function assertNoParkedReversals(
  parked: ParkedReversalRow[],
  ctx: { categoryName: string; periodKey: string },
): void {
  if (parked.length === 0) return;
  const unresolvable = parked.filter((p) => !p.categoryResolved);
  throw new ConflictException({
    code: API_ERROR_CODES.PARKED_REVERSALS_UNRESOLVED,
    count: parked.length,
    returnIds: [...new Set(parked.map((p) => p.returnId))],
    message:
      `${parked.length} return reversal(s) for ${ctx.categoryName} ${ctx.periodKey} are parked (pack unknown) ` +
      `and are not in these figures. Resolve them, then prepare the filing again.` +
      (unresolvable.length > 0
        ? ` ${unresolvable.length} of them point at a sale entry that cannot be found, so they block every category of this period (${[
            ...new Set(unresolvable.map((p) => p.reason)),
          ].join("; ")}).`
        : ""),
    reasons: [...new Set(parked.map((p) => p.reason))],
  });
}

/**
 * Puts the parked rows FIRST on a report (payload, warnings and the CSV preamble). The export is a PREVIEW,
 * never a filing, whenever a row is parked. Returns a new report; `parked` is the first key so it leads the JSON.
 */
export function withParkedFirst(
  report: RegulatedReport,
  parked: ParkedReversalRow[],
  restockNote: string | null,
): RegulatedReport {
  if (parked.length === 0 && !restockNote) return report;
  const warnings = [...report.warnings];
  let csv = report.csv;
  if (parked.length > 0) {
    warnings.unshift({
      code: "PARKED_REVERSALS",
      message: `${parked.length} return reversal(s) are parked (pack unknown) and are NOT in these figures; the period cannot be filed until they are resolved.`,
    });
    csv = {
      ...csv,
      preamble: [
        [`PREVIEW — ${parked.length} unresolved parked reversal(s); do not file from this export`],
        ...csv.preamble,
      ],
    };
  }
  return { parked, parkedRestockNote: restockNote, ...report, warnings, csv } as RegulatedReport;
}
