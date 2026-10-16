import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * B846 / SA-808 — the date a bill-driven stock row is booked at. One module, one filed-period
 * predicate (SA-802 shares it): a stock write whose accounting instant falls in a period that has
 * been FILED must not change that filing's live figures.
 *
 * - Dates a person chooses inside a filed period are refused (SA-802, not here).
 * - Dates a DOCUMENT carries (a bill's date, the receipt a reversal undoes) move forward to `now`
 *   instead, so the filed period never moves and the bill can still be fixed.
 * - If `now` is itself filed, fail closed with 409 STOCK_DATE_IN_FILED_PERIOD naming the period.
 *
 * Filed (SA-802): a non-FAILED TobaccoReport for a tobacco product; a GENERATED or LOCKED
 * RegulatedFiling for the product's tracked category. Non-regulated products never move.
 */

export interface StockDateProduct {
  id: string;
  isTobacco: boolean;
  trackedCategoryId: string | null;
}

/** The minimal client surface the predicate reads; a tenant transaction satisfies it. */
export interface StockDateDb {
  product: { findMany(args: any): Promise<any> };
  tobaccoReport: { findFirst(args: any): Promise<any> };
  regulatedFiling: { findFirst(args: any): Promise<any> };
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const monthLabel = (d: Date): string => `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

/** The label of the filed period holding `at` for this product, or null when that instant is open. */
export async function filedPeriodOf(
  db: StockDateDb,
  args: { tenantId: string; product: StockDateProduct; at: Date },
): Promise<string | null> {
  const { tenantId, product, at } = args;
  if (product.isTobacco) {
    const report = await db.tobaccoReport.findFirst({
      where: {
        tenantId,
        status: { not: "FAILED" },
        periodStart: { lte: at },
        periodEnd: { gte: at },
      },
      select: { periodStart: true },
    });
    if (report) return monthLabel(report.periodStart);
  }
  if (product.trackedCategoryId) {
    const filing = await db.regulatedFiling.findFirst({
      where: {
        tenantId,
        trackedCategoryId: product.trackedCategoryId,
        status: { in: ["GENERATED", "LOCKED"] },
        periodStart: { lte: at },
        periodEnd: { gt: at },
      },
      select: { periodStart: true, periodKey: true, cadence: true },
    });
    if (filing) {
      return filing.cadence === "MONTHLY" || filing.cadence == null
        ? monthLabel(filing.periodStart)
        : String(filing.periodKey);
    }
  }
  return null;
}

export interface DocumentStockDate {
  /** The instant to write on the row (and its lot). */
  effectiveAt: Date;
  /** The filed period the document date was in, when the row moved forward to `now`; else null. */
  movedFromPeriod: string | null;
}

/** Per-product dating of a document-driven stock row; the decision is per product row. */
export async function documentStockDate(
  db: StockDateDb,
  args: { tenantId: string | null; productIds: string[]; documentDate: Date; now: Date },
): Promise<Map<string, DocumentStockDate>> {
  const { documentDate, now } = args;
  // Fail closed: a filing lookup with no tenant would match nothing and call every period open.
  if (!args.tenantId)
    throw new Error("documentStockDate needs a tenant: refusing to read no filings");
  const tenantId = args.tenantId;
  const ids = [...new Set(args.productIds)];
  const out = new Map<string, DocumentStockDate>();
  if (ids.length === 0) return out;
  const found: StockDateProduct[] =
    (await db.product.findMany({
      where: { id: { in: ids } },
      select: { id: true, isTobacco: true, trackedCategoryId: true },
    })) ?? [];
  const byId = new Map(found.map((p) => [p.id, p]));
  for (const id of ids) {
    const product = byId.get(id);
    const filed = product ? await filedPeriodOf(db, { tenantId, product, at: documentDate }) : null;
    if (!product || filed == null) {
      out.set(id, { effectiveAt: documentDate, movedFromPeriod: null });
      continue;
    }
    const filedNow = await filedPeriodOf(db, { tenantId, product, at: now });
    if (filedNow != null) {
      throw new ConflictException({
        code: API_ERROR_CODES.STOCK_DATE_IN_FILED_PERIOD,
        message:
          `This stock movement can't be dated today: ${filedNow} is already filed for this product. ` +
          "Ask an admin before changing it.",
        productId: id,
        period: filedNow,
      });
    }
    out.set(id, { effectiveAt: now, movedFromPeriod: filed });
  }
  return out;
}
