import { monthRange } from "./period";

/**
 * SA-819 MUST 1: the ONE module that reads "what is filed". Every `regulatedFiling` / `tobaccoReport`
 * status filter lives here; `filed-periods.pin.spec.ts` fails on one anywhere else in `src`.
 *
 * Three tiers, DELIBERATELY different. Do not merge them; pick the one that matches the question:
 *
 *  | export                  | statuses            | shape                  | question it answers                         |
 *  | ----------------------- | ------------------- | ---------------------- | ------------------------------------------- |
 *  | `lockedFilingsCovering` | LOCKED              | per (category, bucket) | may a sales EDIT / undo touch this bucket?  |
 *  | `filedThroughOf`        | GENERATED, LOCKED   | cumulative "through"   | is this STOCK date inside a filed period?   |
 *  | `findFiledPeriod`       | GENERATED, LOCKED   | per (category, bucket) | which filed period does this label name?    |
 *
 * Helpers below (`anyLockedFiling`, `findLockedFiling`, `findGeneratedTobaccoReport`) are the same tiers read
 * for one other purpose each; they sit here so no status literal leaks out.
 */

/** The minimal filings client surface (a tenant transaction, `forTenant()`, or a unit-test stub). */
export type FilingsDb = {
  regulatedFiling?: {
    findMany?(args: unknown): Promise<any[]>;
    findFirst?(args: any): Promise<any>;
  };
};

// ---------------------------------------------------------------------------------------------------------
// Tier 1 - LOCKED only, per bucket (sales edits, the ledger guard, the undo guard)
// ---------------------------------------------------------------------------------------------------------

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

/**
 * LOCKED only (owner 2026-09-14: LOCKED is the explicit close). A GENERATED filing is a draft the owner can
 * still regenerate, so a sales edit or ledger row into its period is allowed; only a lock freezes a period.
 * Per bucket, because a sale lives in one month: a filing covers a bucket when the bucket's month starts
 * inside its [periodStart, periodEnd). A client without a filings model (a unit-test stub) covers nothing.
 */
export async function lockedFilingsCovering(
  db: FilingsDb,
  refs: BucketRef[],
): Promise<Array<{ filing: LockedFilingRow; trackedCategoryId: string; periodBucket: string }>> {
  if (refs.length === 0 || !db.regulatedFiling?.findMany) return [];
  const categoryIds = [...new Set(refs.map((r) => r.trackedCategoryId))];
  const filings = (await db.regulatedFiling.findMany({
    where: { trackedCategoryId: { in: categoryIds }, status: "LOCKED" },
  })) as LockedFilingRow[];
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

/** Cheap exit probe for the edit guard: does ANY filing hold the LOCKED status? (LOCKED tier.) */
export async function anyLockedFiling(db: FilingsDb): Promise<boolean> {
  if (!db.regulatedFiling?.findMany) return false;
  const rows = await db.regulatedFiling.findMany({ where: { status: "LOCKED" }, take: 1 });
  return rows.length > 0;
}

/** The LOCKED filing for one (category, periodKey), or null (`prepareFiling` never regenerates it). */
export async function findLockedFiling(
  db: { regulatedFiling: { findFirst(args: any): Promise<any> } },
  where: { trackedCategoryId: string; periodKey: string },
): Promise<any | null> {
  return (await db.regulatedFiling.findFirst({ where: { ...where, status: "LOCKED" } })) ?? null;
}

// ---------------------------------------------------------------------------------------------------------
// Tier 2 - GENERATED | LOCKED (and a non-FAILED tobacco report), cumulative "through" (stock dates)
// ---------------------------------------------------------------------------------------------------------

export interface FiledProduct {
  id: string;
  isTobacco: boolean;
  trackedCategoryId: string | null;
  /** The tracked category's name, which the 409 names (W-755). */
  trackedCategory?: { name: string } | null;
}

/** The minimal client surface `filedThroughOf` reads; a tenant transaction satisfies it. */
export interface FiledThroughDb {
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
  /** WHAT is filed: "Tobacco" or the tracked category's name (SA-894 LOW-1). */
  filedFor: string;
}

/**
 * One filing read per key per call (W-755): the tobacco report is tenant-wide and a filing is per
 * category, so a count of many products reads each once. Lives only for one stock-date call, on whatever
 * client the caller passes.
 */
export type FiledCache = Map<string, Promise<FiledThrough | null>>;

const tobaccoFiled = (db: FiledThroughDb, tenantId: string, cache: FiledCache) => {
  const key = "tobacco";
  if (!cache.has(key)) {
    cache.set(
      key,
      db.tobaccoReport
        .findFirst({
          where: { tenantId, status: { not: "FAILED" } },
          orderBy: { periodEnd: "desc" },
          select: { periodStart: true, periodEnd: true },
        })
        .then((report: any) =>
          report
            ? {
                // A tobacco report stores an INCLUSIVE end: the close is the next millisecond.
                through: new Date(new Date(report.periodEnd).getTime() + 1),
                label: monthLabel(report.periodStart),
                filedFor: "Tobacco",
              }
            : null,
        ),
    );
  }
  return cache.get(key)!;
};

const categoryFiled = (
  db: FiledThroughDb,
  tenantId: string,
  product: FiledProduct,
  cache: FiledCache,
) => {
  const key = `category:${product.trackedCategoryId}`;
  if (!cache.has(key)) {
    cache.set(
      key,
      db.regulatedFiling
        .findFirst({
          where: {
            tenantId,
            trackedCategoryId: product.trackedCategoryId,
            status: { in: ["GENERATED", "LOCKED"] },
          },
          orderBy: { periodEnd: "desc" },
          select: { periodStart: true, periodEnd: true, periodKey: true, cadence: true },
        })
        .then((filing: any) =>
          filing
            ? {
                through: new Date(filing.periodEnd), // already exclusive
                label:
                  filing.cadence === "MONTHLY" || filing.cadence == null
                    ? monthLabel(filing.periodStart)
                    : String(filing.periodKey),
                filedFor: product.trackedCategory?.name ?? "this product's category",
              }
            : null,
        ),
    );
  }
  return cache.get(key)!;
};

/**
 * SA-808a: "filed" means filed THROUGH, not filed AT. A month's ending stock is `currentStock -
 * sum(movements after periodEnd)`, so a movement dated `t` changes the ending stock of every month
 * ending at or after `t`: a row backdated into an unfiled August still moves a filed September. That is why
 * this tier is cumulative while the sales tiers are per bucket (a sale lives in one month, a stock level
 * accumulates). GENERATED counts as filed here (the figures were produced and may have been submitted), the
 * stricter reading, because a stock row cannot be re-dated afterwards.
 * Returns the close of the LATEST filed period covering the product (tobacco or its category: the later close
 * wins, a tie keeps tobacco), or null. A FAILED month after the latest filed one stays open; a FAILED month
 * before it is closed.
 */
export async function filedThroughOf(
  db: FiledThroughDb,
  tenantId: string,
  product: FiledProduct,
  cache: FiledCache,
): Promise<FiledThrough | null> {
  let best: FiledThrough | null = null;
  if (product.isTobacco) best = await tobaccoFiled(db, tenantId, cache);
  if (product.trackedCategoryId) {
    const filing = await categoryFiled(db, tenantId, product, cache);
    if (filing && (!best || filing.through > best.through)) best = filing;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------
// Tier 3 - GENERATED | LOCKED, per bucket (labels on parked-reversal resolutions and undos)
// ---------------------------------------------------------------------------------------------------------

/** #2108: a filed (GENERATED or LOCKED) filing period a parked reversal would otherwise book into, and
 *  the category whose filing matched. */
export interface FiledPeriod {
  periodKey: string;
  status: string;
  trackedCategoryId: string;
}

/**
 * The filed period (any of `categoryIds`) that contains `bucket`, or null. GENERATED counts as well as LOCKED
 * because this only LABELS the period ("this books against a month that has a filing"), it never refuses a
 * write: the stricter, refusing reading is tier 1. Deterministic: with two filed categories the lowest
 * category id, then period key, wins (SA-213), and the matched category is returned so the response names the
 * right one.
 */
export async function findFiledPeriod(
  db: any,
  categoryIds: string[],
  bucket: string,
): Promise<FiledPeriod | null> {
  if (categoryIds.length === 0) return null;
  const bucketStart = new Date(`${bucket}-01T00:00:00.000Z`);
  const filing = await db.regulatedFiling.findFirst({
    where: {
      trackedCategoryId: { in: categoryIds },
      periodStart: { lte: bucketStart },
      periodEnd: { gt: bucketStart },
      status: { in: ["GENERATED", "LOCKED"] },
    },
    orderBy: [{ trackedCategoryId: "asc" }, { periodKey: "asc" }],
    select: { periodKey: true, status: true, trackedCategoryId: true },
  });
  return filing
    ? {
        periodKey: filing.periodKey,
        status: filing.status,
        trackedCategoryId: filing.trackedCategoryId,
      }
    : null;
}

// ---------------------------------------------------------------------------------------------------------
// The legacy monthly tobacco report cron (GENERATED = already produced for the month)
// ---------------------------------------------------------------------------------------------------------

/** The tenant's already-GENERATED tobacco report for a month, or null (the cron's idempotency probe). */
export async function findGeneratedTobaccoReport(
  db: { tobaccoReport: { findFirst(args: any): Promise<any> } },
  period: { year: number; month: number },
): Promise<any | null> {
  return (
    (await db.tobaccoReport.findFirst({
      where: { periodYear: period.year, periodMonth: period.month, status: "GENERATED" },
    })) ?? null
  );
}
