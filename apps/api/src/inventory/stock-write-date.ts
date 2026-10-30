import { BadRequestException, ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  filedThroughOf,
  type FiledCache,
  type FiledProduct,
  type FiledThroughDb,
} from "../regulated/filed-periods";

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

export type StockDateProduct = FiledProduct;

/** The minimal client surface the predicate reads; a tenant transaction satisfies it. */
export type StockDateDb = FiledThroughDb & { product: { findMany(args: any): Promise<any> } };

const loadProducts = async (db: StockDateDb, ids: string[]): Promise<StockDateProduct[]> =>
  (await db.product.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      isTobacco: true,
      trackedCategoryId: true,
      trackedCategory: { select: { name: true } },
    },
  })) ?? [];

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
  const cache: FiledCache = new Map();
  for (const id of ids) {
    const product = byId.get(id);
    const filed = product ? await filedThroughOf(db, tenantId, product, cache) : null;
    if (!filed || documentDate >= filed.through) {
      out.set(id, { effectiveAt: documentDate, movedFromPeriod: null });
      continue;
    }
    if (now < filed.through) {
      throw new ConflictException({
        code: API_ERROR_CODES.STOCK_DATE_IN_FILED_PERIOD,
        message:
          `This stock movement can't be dated today: ${filed.label} is already filed for ${filed.filedFor}. ` +
          "Ask an admin before changing it.",
        productId: id,
        period: filed.label,
        filedFor: filed.filedFor,
      });
    }
    out.set(id, { effectiveAt: now, movedFromPeriod: filed.label });
  }
  return out;
}

/** Clock-skew allowance for a client-sent "now" effective date. */
const EFFECTIVE_DATE_SKEW_MS = 5 * 60 * 1000;

/**
 * B562 PR-3: a stock write's accounting date — the given `effectiveDate` or now. A FUTURE date is
 * refused: it would sort after every real row still to come, so each later write would count it as
 * "newer" and replay against a movement that has not happened yet. Row 563: only `stockWriteDate`
 * calls it for a stock write (the pin forbids a bypass).
 */
export function effectiveDateOf(raw: string | undefined, now = new Date()): Date {
  if (!raw) return now;
  const date = new Date(raw);
  if (date.getTime() > now.getTime() + EFFECTIVE_DATE_SKEW_MS) {
    throw new BadRequestException("The effective date can't be in the future.");
  }
  return date;
}

const dayLabel = (d: Date): string =>
  d.toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * Row 563 (SA-794 → SA-802 → SA-802a / SA-808a): the ONE date gate for every stock write whose date a PERSON chose (an
 * adjustment, a purchase, a count, the legacy one-shot count). In order:
 *  1. `effectiveDateOf(raw)`: a future date is the existing 400; no date means now (and nothing is read).
 *  2. For each touched product, the latest filed period (`filedThroughOf`, shared with `documentStockDate`): a date
 *     before its close would change a filed figure, so it is REFUSED (409 STOCK_DATE_IN_FILED_PERIOD, naming the period).
 *     Never clamped, unlike a document date: the person chose this date. A filed month is amended outside the app.
 *  3. Otherwise the date: non-regulated products keep backdating (the cost replay supports it).
 * A count checks ALL its line products before anything is written.
 */
export async function stockWriteDate(
  db: StockDateDb,
  args: { tenantId: string | null; productIds: string[]; raw: string | undefined; now?: Date },
): Promise<Date> {
  const date = effectiveDateOf(args.raw, args.now);
  if (!args.raw) return date;
  // Fail closed: a filing lookup with no tenant would match nothing and call every period open.
  if (!args.tenantId) throw new Error("stockWriteDate needs a tenant: refusing to read no filings");
  const tenantId = args.tenantId;
  const ids = [...new Set(args.productIds)];
  if (ids.length === 0) return date;
  const products = await loadProducts(db, ids);
  const cache: FiledCache = new Map();
  for (const product of products) {
    if (!product.isTobacco && !product.trackedCategoryId) continue;
    // eslint-disable-next-line no-await-in-loop
    const filed = await filedThroughOf(db, tenantId, product, cache);
    if (filed && date < filed.through) {
      const lastFiledDay = dayLabel(new Date(filed.through.getTime() - 1));
      throw new ConflictException({
        code: API_ERROR_CODES.STOCK_DATE_IN_FILED_PERIOD,
        message:
          `This date is on or before ${lastFiledDay}, which is already filed for ${filed.filedFor} (${filed.label}). ` +
          `Use a date after ${lastFiledDay}.`,
        productId: product.id,
        period: filed.label,
        filedFor: filed.filedFor,
      });
    }
  }
  return date;
}
