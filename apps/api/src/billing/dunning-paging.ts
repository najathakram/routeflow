import type { Prisma } from "@prisma/client";
import type { DunningDeps } from "./dunning-core";

/** A subscription row as the periodic sweeps see it. */
export interface PagedRow {
  tenantId: string;
  stripeSubId: string | null;
  externalPayment: boolean;
  catchupState: string | null;
  pastDueInvoiceId: string | null;
}

export interface PagingOptions {
  /** Row budget for one run. */
  maxRows: number;
  /** Keyset page size. */
  batchSize: number;
  /** Wall-clock budget for one run, ms. */
  timeBudgetMs: number;
  /** The rotation unit: the start row advances once per unit (an hour for the reconciler, a day for discovery). */
  unitMs: number;
  /**
   * Process-local rotation memory + its key: when a run is cut short by the TIME budget the next run starts where
   * this one actually stopped (start + rows processed), so the tail is never starved. Without an entry (first run,
   * restart, another replica) the hour-derived rotation below applies.
   */
  cursors?: Map<string, string>;
  cursorKey?: string;
  /** Injectable clock (ms) for the time budget; defaults to Date.now. */
  clock?: () => number;
}

/**
 * SA-733r7 fold (Opus review): visit the WHOLE population of a periodic sweep, with no persisted cursor.
 *
 * A keyset cursor (`tenantId > last`) reads bounded pages. When the population is larger than the row budget the
 * run starts at row `unitIndex * budget mod total` and wraps around, so successive runs cover every row: each run
 * handles `budget` consecutive rows and the next run starts where this one ended. Returns the rows visited.
 */
export async function forEachRotated(
  prisma: DunningDeps["prisma"],
  where: Prisma.TenantSubscriptionWhereInput,
  runAt: Date,
  opts: PagingOptions,
  visit: (row: PagedRow) => Promise<void>,
): Promise<number> {
  const now = opts.clock ?? Date.now;
  const deadline = now() + opts.timeBudgetMs;
  const total = await prisma.tenantSubscription.count({ where });
  if (total === 0) return 0;
  const budget = Math.min(total, opts.maxRows);
  // The remembered cursor is the LAST tenantId visited (a keyset), not a row index: a population that grows or
  // shrinks between runs neither skips nor repeats rows.
  const remembered = opts.cursors && opts.cursorKey ? opts.cursors.get(opts.cursorKey) : undefined;
  const startIdx =
    total > budget ? (Math.floor(runAt.getTime() / opts.unitMs) * budget) % total : 0;
  const startAt =
    remembered !== undefined
      ? remembered
      : startIdx === 0
        ? null
        : ((
            await prisma.tenantSubscription.findMany({
              where,
              select: { tenantId: true },
              orderBy: { tenantId: "asc" },
              skip: startIdx - 1,
              take: 1,
            })
          )[0]?.tenantId ?? null);

  let processed = 0;
  let lastVisited: string | null = null;
  const page = async (cursor: string | null, upTo: string | null): Promise<void> => {
    let last = cursor;
    while (processed < budget && now() < deadline) {
      const rows = await prisma.tenantSubscription.findMany({
        where: {
          ...where,
          ...(last || upTo
            ? { tenantId: { ...(last ? { gt: last } : {}), ...(upTo ? { lte: upTo } : {}) } }
            : {}),
        },
        select: {
          tenantId: true,
          stripeSubId: true,
          externalPayment: true,
          catchupState: true,
          pastDueInvoiceId: true,
        },
        orderBy: { tenantId: "asc" },
        take: Math.min(opts.batchSize, budget - processed),
      });
      if (rows.length === 0) return;
      for (const r of rows) {
        if (now() >= deadline) return; // the time budget is checked per row, not just per page
        processed++;
        lastVisited = r.tenantId;
        await visit(r);
      }
      last = rows[rows.length - 1].tenantId;
    }
  };
  await page(startAt, null); // from the start row to the end of the keyset
  if (startAt && processed < budget) await page(null, startAt); // wrap to the beginning, up to the start row
  if (opts.cursors && opts.cursorKey && lastVisited !== null)
    opts.cursors.set(opts.cursorKey, lastVisited);
  return processed;
}
