/**
 * B785 / SA-116 / SA-133: the run read (findAllRuns/findOneRun/findMyRuns's 4
 * RUN_STOP_INCLUDE-derived call sites, routes.service.ts) projects a per-line
 * `deliveredSoFar` onto EACH stop's own lineItems — the cumulative evidence-basis
 * quantity delivered at every OTHER visit (any run/stop), SERVED FROM ROWS
 * (`delivered-so-far.ts`'s shared stop-relative sum — SA-113a/SA-131a's "one basis
 * everywhere"), never `OrderItem.deliveredQty`. Excluding the stop's OWN rows
 * matters: a stop that already ran must show what was delivered BEFORE it, not a
 * number inflated by its own completion (so an omitted line on a later visit reads
 * as the true REMAINING, qty − deliveredSoFar, never the full qty).
 *
 * Same batching shape as run-invoice-balance.ts's `withPayableInvoices`: ONE
 * `deliveryMutation.findMany` across every order id at the stop(s) being read,
 * grouped by line, then summed per-stop with that stop's own rows excluded.
 */
import {
  DeliveryMutationFindManyClient,
  RawEvidenceRowWithStop,
  deliveredSoFarForLine,
  fetchEvidenceByLine,
  lineRemaining,
} from "./delivered-so-far";

type EvidenceByLine = Record<string, Record<string, RawEvidenceRowWithStop[]>>;

/**
 * Attaches each line's `deliveredSoFar` AND `remaining` onto a stops array. SA-366: `remaining` is
 * the server-computed `lineRemaining` — the SAME value `assertDeliveriesFitStop` bounds against,
 * including F-05's exact 0 for a CANCELLED line or a line of a CANCELLED / DRAFT order — so the
 * driver's stepper defaults to it and never derives `qty − deliveredSoFar` itself (SA-070).
 * `deliveredSoFar` stays for display-only money (SA-367b). Call this exactly once per read, right
 * after the batched fetch, before a RUN_STOP_INCLUDE-derived response leaves the service.
 */
export function attachDeliveredSoFar<
  TLine extends { id: string; qty?: unknown; deliveredQty?: unknown; status?: string | null },
  TOrder extends { id: string; status?: string | null; lineItems?: TLine[] | null },
  TStop extends { id: string; orders?: TOrder[] | null },
>(stops: TStop[], evidenceByLine: EvidenceByLine) {
  return stops.map((s) => ({
    ...s,
    orders: (s.orders ?? []).map((o) => ({
      ...o,
      lineItems: (o.lineItems ?? []).map((li) => {
        // SA-345a: a line with no row anywhere reads the legacy column (see deliveredSoFarForLine).
        const deliveredSoFar = deliveredSoFarForLine(
          evidenceByLine[o.id]?.[li.id],
          s.id,
          li.deliveredQty,
          li.qty,
        );
        return {
          ...li,
          deliveredSoFar,
          remaining: lineRemaining({
            qty: li.qty,
            lineStatus: li.status,
            orderStatus: o.status,
            deliveredSoFar,
          }),
        };
      }),
    })),
  }));
}

/**
 * The full per-read orchestration — collects every order id across the given
 * stops, runs ONE batched `deliveryMutation.findMany`, groups, and attaches
 * with each stop's own rows excluded from its own lines' sum.
 */
export async function withDeliveredSoFar<
  TLine extends { id: string; qty?: unknown; deliveredQty?: unknown; status?: string | null },
  TOrder extends { id: string; status?: string | null; lineItems?: TLine[] | null },
  TStop extends { id: string; orders?: TOrder[] | null },
>(db: DeliveryMutationFindManyClient, stops: TStop[]) {
  const orderIds = Array.from(new Set(stops.flatMap((s) => (s.orders ?? []).map((o) => o.id))));
  const evidenceByLine = await fetchEvidenceByLine(db, orderIds);
  return attachDeliveredSoFar(stops, evidenceByLine);
}

/**
 * `withDeliveredSoFar` over a whole PAGE of runs at once (findAllRuns/findMyRuns), then
 * re-distributes the enriched stops back onto each run — the flatMap/batch/slice dance both
 * call sites otherwise duplicate byte-for-byte.
 */
export async function withDeliveredSoFarForRunsPage<
  TLine extends { id: string; qty?: unknown; deliveredQty?: unknown; status?: string | null },
  TOrder extends { id: string; status?: string | null; lineItems?: TLine[] | null },
  TStop extends { id: string; orders?: TOrder[] | null },
  TRun extends { stops: TStop[] },
>(db: DeliveryMutationFindManyClient, runs: TRun[]): Promise<TRun[]> {
  const pageStops = await withDeliveredSoFar(
    db,
    runs.flatMap((r) => r.stops),
  );
  let cursor = 0;
  return runs.map((run) => {
    const stops = pageStops.slice(cursor, cursor + run.stops.length);
    cursor += run.stops.length;
    return { ...run, stops };
  });
}
