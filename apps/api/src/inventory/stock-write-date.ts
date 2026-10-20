import { BadRequestException, ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * B846 / SA-808 — the date a bill-driven stock row is booked at. One module, one filed-period
 * predicate (SA-802 shares it): a stock write whose accounting instant falls in a period that has
 * been FILED must not change that filing's live figures.
 *
 * - Dates a person chooses inside a filed period are refused (SA-802: `stockWriteDate` below).
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
  /** Read only to NAME the category on a refusal; absent, the message says "a regulated category". */
  trackedCategory?: { findFirst(args: any): Promise<any> };
}

/** Clock-skew allowance for a client-sent "now" effective date. */
const EFFECTIVE_DATE_SKEW_MS = 5 * 60 * 1000;
/**
 * B562 PR-3: a stock write's accounting date — the given `effectiveDate` or now. A FUTURE date is
 * refused: it would sort after every real row still to come, so each later write would count it as
 * "newer" and replay against a movement that has not happened yet.
 */
export function effectiveDateOf(raw: string | undefined, now = new Date()): Date {
  if (!raw) return now;
  const date = new Date(raw);
  if (date.getTime() > now.getTime() + EFFECTIVE_DATE_SKEW_MS) {
    throw new BadRequestException("The effective date can't be in the future.");
  }
  return date;
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
 * Returns the close of the LATEST filed period covering the product, or null. A FAILED month
 * after the latest filed one stays open; a FAILED month before it is closed.
 */
async function filedThroughOf(
  db: StockDateDb,
  tenantId: string,
  product: StockDateProduct,
): Promise<FiledThrough | null> {
  let best: FiledThrough | null = null;
  if (product.isTobacco) best = await tobaccoFiledThrough(db, tenantId);
  if (product.trackedCategoryId) {
    const filed = await categoryFiledThrough(db, tenantId, product.trackedCategoryId);
    if (filed && (!best || filed.through > best.through)) best = filed;
  }
  return best;
}

/** Tenant-wide: the close of the latest non-FAILED TobaccoReport (periodEnd is inclusive, +1 ms). */
async function tobaccoFiledThrough(
  db: StockDateDb,
  tenantId: string,
): Promise<FiledThrough | null> {
  const report = await db.tobaccoReport.findFirst({
    where: { tenantId, status: { not: "FAILED" } },
    orderBy: { periodEnd: "desc" },
    select: { periodStart: true, periodEnd: true },
  });
  if (!report) return null;
  return {
    through: new Date(new Date(report.periodEnd).getTime() + 1),
    label: monthLabel(report.periodStart),
  };
}

/** The close of the latest GENERATED or LOCKED RegulatedFiling of one tracked category. */
async function categoryFiledThrough(
  db: StockDateDb,
  tenantId: string,
  trackedCategoryId: string,
): Promise<FiledThrough | null> {
  const filing = await db.regulatedFiling.findFirst({
    where: { tenantId, trackedCategoryId, status: { in: ["GENERATED", "LOCKED"] } },
    orderBy: { periodEnd: "desc" },
    select: { periodStart: true, periodEnd: true, periodKey: true, cadence: true },
  });
  if (!filing) return null;
  return {
    through: new Date(filing.periodEnd), // already exclusive
    label:
      filing.cadence === "MONTHLY" || filing.cadence == null
        ? monthLabel(filing.periodStart)
        : String(filing.periodKey),
  };
}

const loadProducts = async (db: StockDateDb, ids: string[]): Promise<StockDateProduct[]> =>
  (await db.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, isTobacco: true, trackedCategoryId: true },
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
  for (const id of ids) {
    const product = byId.get(id);
    const filed = product ? await filedThroughOf(db, tenantId, product) : null;
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

const dayLabel = (d: Date): string =>
  d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

/**
 * SA-802 / SA-802a: the one date gate for a stock write whose date a PERSON chose (purchase,
 * adjustment, stock count). A future date is a 400 (`effectiveDateOf`); a date before the close of
 * the latest filed period covering ANY product in the write is a 409 STOCK_DATE_IN_FILED_PERIOD that
 * names the last filed day and the category, and the caller writes nothing. Call it BEFORE any lock
 * or transaction. One union close per write: a single tobacco read, and one filing read per DISTINCT
 * tracked category (a count holds hundreds of lines).
 */
export async function stockWriteDate(
  db: StockDateDb,
  args: { tenantId: string | null; productIds: string[]; raw: string | undefined; now?: Date },
): Promise<Date> {
  const date = effectiveDateOf(args.raw, args.now);
  // Fail closed: a filing lookup with no tenant would match nothing and call every period open.
  if (!args.tenantId) throw new Error("stockWriteDate needs a tenant: refusing to read no filings");
  const tenantId = args.tenantId;
  const ids = [...new Set(args.productIds)];
  if (ids.length === 0) return date;
  const products = await loadProducts(db, ids);

  // The latest close wins, and its source (tobacco, or a category id) names the refusal.
  let latest: { filed: FiledThrough; categoryId: string | null } | null = null;
  const consider = (filed: FiledThrough | null, categoryId: string | null) => {
    if (filed && (!latest || filed.through > latest.filed.through)) latest = { filed, categoryId };
  };
  if (products.some((p) => p.isTobacco)) consider(await tobaccoFiledThrough(db, tenantId), null);
  const categoryIds = new Set<string>();
  for (const p of products) if (p.trackedCategoryId) categoryIds.add(p.trackedCategoryId);
  for (const categoryId of categoryIds) {
    consider(await categoryFiledThrough(db, tenantId, categoryId), categoryId);
  }

  const found = latest as { filed: FiledThrough; categoryId: string | null } | null;
  if (!found || date >= found.filed.through) return date;
  const lastDay = dayLabel(new Date(found.filed.through.getTime() - 1));
  const category = found.categoryId
    ? ((
        await db.trackedCategory?.findFirst({
          where: { id: found.categoryId },
          select: { name: true },
        })
      )?.name ?? "a regulated category")
    : "tobacco";
  throw new ConflictException({
    code: API_ERROR_CODES.STOCK_DATE_IN_FILED_PERIOD,
    message: `This date is on or before ${lastDay}, which is already filed (for ${category}). Use a date after ${lastDay}.`,
    period: found.filed.label,
    filedThrough: found.filed.through.toISOString(),
  });
}
