import type { RouteAnalysisResult } from "@/lib/api/routes";

/** A stop that misses its delivery window, as reported by a fresh
 *  `useAnalyzeRoute` call. */
export interface LateStop {
  stopId: string;
  label: string;
}

export function lateStopsFromAnalysis(result: RouteAnalysisResult): LateStop[] {
  return (result.etas ?? [])
    .filter((eta) => eta.withinWindow === false)
    .map((eta) => ({
      stopId: eta.stopId,
      label: `${eta.customerName} — ETA ${eta.arrivalTime} misses window (ends ${
        eta.deliveryWindowEnd ?? "?"
      })`,
    }));
}

/** Status of a dispatch modal's delivery-window feasibility check.
 *  `failed` fails OPEN — the operator is told the check did not run, but is
 *  never locked out of dispatching by a throttled or gated analyze call. */
export type WindowCheckState = "idle" | "checking" | "ok" | "failed";
