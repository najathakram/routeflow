/**
 * B785/SA-116 then B810/SA-130a: the two additive per-stop projections every RUN_STOP_INCLUDE-
 * derived read needs — line-item `deliveredSoFar` (run-delivered-so-far.ts) and order-level
 * `payableInvoices` (run-invoice-balance.ts) — chained in ONE call so the 4 call sites
 * (findAllRuns/findOneRun ×2/findMyRuns, routes.service.ts) can't drift on ordering or grow the
 * file's own size-ratchet footprint with 4 near-duplicate chains.
 */
import { withDeliveredSoFar, withDeliveredSoFarForRunsPage } from "./run-delivered-so-far";
import { withPayableInvoices, withPayableInvoicesForRuns } from "./run-invoice-balance";

/** `withPayableInvoices` for a flat orders array (no stop wrapper) — findOneRun's legacy-fallback
 *  branch (call site 2 of 4) has bare orders, not stops, so it wraps/unwraps a single pseudo-stop. */
export async function withPayableInvoicesFlat<TOrder extends { id: string }>(
  db: Parameters<typeof withPayableInvoices>[0],
  orders: TOrder[],
) {
  const [{ orders: withBalances }] = await withPayableInvoices(db, [{ orders }]);
  return withBalances;
}

export async function withRunStopProjections<
  TLine extends { id: string },
  TOrder extends { id: string; lineItems?: TLine[] | null },
  TStop extends { id: string; orders?: TOrder[] | null },
>(
  db: Parameters<typeof withDeliveredSoFar>[0] & Parameters<typeof withPayableInvoices>[0],
  stops: TStop[],
) {
  return withPayableInvoices(db, await withDeliveredSoFar(db, stops));
}

export async function withRunStopProjectionsForRunsPage<
  TLine extends { id: string },
  TOrder extends { id: string; lineItems?: TLine[] | null },
  TStop extends { id: string; orders?: TOrder[] | null },
  TRun extends { stops: TStop[] },
>(
  db: Parameters<typeof withDeliveredSoFarForRunsPage>[0] &
    Parameters<typeof withPayableInvoicesForRuns>[0],
  runs: TRun[],
) {
  return withPayableInvoicesForRuns(db, await withDeliveredSoFarForRunsPage(db, runs));
}
