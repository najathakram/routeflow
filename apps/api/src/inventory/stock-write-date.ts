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
 * Filed (SA-802 / SA-808a): a non-FAILED TobaccoReport for a tobacco product; a GENERATED or LOCKED
 * RegulatedFiling for the product's tracked category; closed THROUGH the latest such period.
 * Non-regulated products never move.
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

const monthLabel = (d: Date): string =>
  `${d.toLocaleString("en-US", { month: "long", timeZone: "UTC" })} ${d.getUTCFullYear()}`;

export interface FiledThrough {
  /** EXCLUSIVE close of the latest filed period: an instant `t` is closed when `t < through`. */
  through: Date;
  /** That period's label ("September 2026"), for the note and the 409 message. */
  label: string;
}

/**
 * SA-808a: "filed" means filed THROUGH, not filed AT. A month's ending stock is `currentStock −
 * Σ(movements after periodEnd)`, so a movement dated `t` changes the ending stock of every month
 * ending at or after `t`: a row backdated into an unfiled August still moves a filed September.
 * Returns the close of the LATEST filed period covering any of the products, or null. A FAILED month
 * after the latest filed one stays open; a FAILED month before it is closed.
 */
async function filedThroughOf(
  db: StockDateDb,
  tenantId: string,
  products: StockDateProduct[],
): Promise<FiledThrough | null> {
  let best: FiledThrough | null = null;
  if (products.some((p) => p.isTobacco)) {
    const report = await db.tobaccoReport.findFirst({
      where: { tenantId, status: { not: "FAILED" } },
      orderBy: { periodEnd: "desc" },
      select: { periodStart: true, periodEnd: true },
    });
    if (report) {
      best = {
        through: new Date(new Date(report.periodEnd).getTime() + 1),
        label: monthLabel(report.periodStart),
      };
    }
  }
  const categoryIds = [
    ...new Set(products.flatMap((p) => (p.trackedCategoryId ? [p.trackedCategoryId] : []))),
  ];
  if (categoryIds.length > 0) {
    const filing = await db.regulatedFiling.findFirst({
      where: {
        tenantId,
        trackedCategoryId: { in: categoryIds },
        status: { in: ["GENERATED", "LOCKED"] },
      },
      orderBy: { periodEnd: "desc" },
      select: { periodStart: true, periodEnd: true, periodKey: true, cadence: true },
    });
    if (filing) {
      const through = new Date(filing.periodEnd); // already exclusive
      if (!best || through > best.through) {
        best = {
          through,
          label:
            filing.cadence === "MONTHLY" || filing.cadence == null
              ? monthLabel(filing.periodStart)
              : String(filing.periodKey),
        };
      }
    }
  }
  return best;
}

const loadProducts = async (db: StockDateDb, ids: string[]): Promise<StockDateProduct[]> =>
  (await db.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, isTobacco: true, trackedCategoryId: true },
  })) ?? [];

/** The close of the latest filed period covering any of `productIds`, or null when none is filed. */
export async function filedThrough(
  db: StockDateDb,
  args: { tenantId: string; productIds: string[] },
): Promise<FiledThrough | null> {
  return filedThroughOf(db, args.tenantId, await loadProducts(db, [...new Set(args.productIds)]));
}

export interface DocumentStockDate {
  /** The instant to write on the row (and its lot). */
  effectiveAt: Date;
  /** The label of the filing that closed the document date, when the row moved forward; else null. */
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
  const byId = new Map((await loadProducts(db, ids)).map((p) => [p.id, p]));
  for (const id of ids) {
    const product = byId.get(id);
    const filed = product ? await filedThroughOf(db, tenantId, [product]) : null;
    if (!filed || documentDate >= filed.through) {
      out.set(id, { effectiveAt: documentDate, movedFromPeriod: null });
      continue;
    }
    if (now < filed.through) {
      throw new ConflictException({
        code: API_ERROR_CODES.STOCK_DATE_IN_FILED_PERIOD,
        message:
          `This stock movement can't be dated today: ${filed.label} is already filed for this product. ` +
          "Ask an admin before changing it.",
        productId: id,
        period: filed.label,
      });
    }
    out.set(id, { effectiveAt: now, movedFromPeriod: filed.label });
  }
  return out;
}
