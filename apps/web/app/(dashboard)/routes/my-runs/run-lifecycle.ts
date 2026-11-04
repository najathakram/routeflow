import type { RouteRun, RouteRunStop } from "@/lib/api/routes";
import { driverRunFooter } from "@/lib/run-settlement-controls";

// A plain module beside the page, not exports of it: Next types a page file's exports, so a helper exported from
// page.tsx fails `tsc` in any tree that holds a generated `.next/types` for that page.

/** SA-1098 PR-2 / A-1: "" when Finish route is the run's one primary, null otherwise. The decision is the shared
 *  `driverRunFooter`: a run holding cash or checks with no settlement gets "Settle your run" (RunSettleFooter) instead. */
export function finishRouteBlocker(run: RouteRun, stops: RouteRunStop[]): string | null {
  return driverRunFooter({ ...run, stops }) === "FINISH" ? "" : null;
}

/**
 * SA-1098 A-2 (D-32): the run as the driver's page keeps it once their completion has finished it. The server ends the run when
 * its last stop lands and the run leaves `my-runs`; this copy stays in memory so the stop's Undo is still one step away.
 */
export function finishedRunView(run: RouteRun, stopId: string): RouteRun {
  return {
    ...run,
    status: "COMPLETED",
    stops: (run.stops ?? []).map((s) => (s.id === stopId ? { ...s, status: "COMPLETED" } : s)),
  };
}
