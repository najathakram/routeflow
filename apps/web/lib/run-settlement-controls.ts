import { expectedPhysicalCash } from "@routeflow/pricing";
import type { RouteRun } from "@/lib/api/routes";

/**
 * SA-1098 A-1 (PR-S): which settlement control a run shows, for the driver's footer and the office's
 * run page. Pure, one place, so the two surfaces cannot drift.
 *
 * The gate reads the MONEY figure (`collectedPayments`), never the `driver_payments` add-on: a tenant
 * whose add-on was removed can still settle money already taken. The server refuses a COMPLETED write
 * while money is unsettled (R7a), so "Finish" only ever shows once the run holds none or is settled.
 */
type RunView = Pick<RouteRun, "status" | "stops" | "collectedPayments" | "settlementNote">;

/** True once the server's figure shows cash or checks on the run. Unloaded or empty is false. */
export function runHoldsMoney(run: Pick<RunView, "collectedPayments">): boolean {
  return (expectedPhysicalCash(run.collectedPayments) ?? 0) > 0;
}

/** The server's own rule (`updateRunStatus`): a stop is done once COMPLETED or SKIPPED. Null = not loaded. */
function noStopLeft(run: Pick<RunView, "stops">): boolean | null {
  if (!run.stops) return null;
  return run.stops.every((s) => s.status === "COMPLETED" || s.status === "SKIPPED");
}

const isSettled = (run: Pick<RunView, "settlementNote">) => run.settlementNote != null;

export type DriverRunFooter = "SETTLE" | "FINISH" | null;

/**
 * The driver's one primary action on a run once no stop is left. A settled run, or one holding no cash
 * or checks, finishes; otherwise the driver settles first. Nothing while a stop is left (the server
 * accepts a settlement then, but cash taken after it would not be counted), or off an in-progress run.
 */
export function driverRunFooter(run: RunView): DriverRunFooter {
  if (run.status !== "IN_PROGRESS" || noStopLeft(run) !== true) return null;
  return runHoldsMoney(run) && !isSettled(run) ? "SETTLE" : "FINISH";
}

export interface OfficeSettlementControls {
  settle: boolean;
  finish: boolean;
  amend: boolean;
}

/**
 * The office's controls on the run page. A driver settles once, so the office is how a miscounted
 * settlement is corrected (Amend) and how a run is settled after its driver has gone home or the run
 * was cancelled with money on it. A cancelled run is never finished (the server refuses it).
 */
export function officeSettlementControls(
  run: RunView,
  isOperator: boolean,
): OfficeSettlementControls {
  const none = { settle: false, finish: false, amend: false };
  if (!isOperator) return none;
  const holds = runHoldsMoney(run);
  const settled = isSettled(run);
  if (run.status === "IN_PROGRESS") {
    if (noStopLeft(run) !== true) return none;
    return holds && !settled ? { ...none, settle: true } : { ...none, finish: true };
  }
  if (run.status === "COMPLETED" || run.status === "CANCELLED") {
    if (settled) return { ...none, amend: true };
    // Money with no settlement on a finished run: the server accepts the post-hoc settle.
    if (holds) return { ...none, settle: true };
  }
  return none;
}
