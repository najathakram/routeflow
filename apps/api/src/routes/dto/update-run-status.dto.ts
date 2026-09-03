import { IsEnum } from "class-validator";
import { RouteRunStatus } from "@prisma/client";

export class UpdateRunStatusDto {
  @IsEnum(RouteRunStatus) status: RouteRunStatus;
}

/**
 * B72: from-state guard for PATCH /route-runs/:id/status. A deny-list, not a
 * whitelist — the endpoint's live callers (web cancel flows, driver
 * start/complete, operator backfill SCHEDULED→COMPLETED) stay untouched; only
 * the two indefensible classes are closed: a cancelled run can never be
 * declared COMPLETED (restart it first — completing it directly would record a
 * finished delivery day the operator had called off), and a COMPLETED run can
 * never be re-SCHEDULED (reopenStop is the sanctioned path back into a
 * completed run).
 *
 * CANCELLED is deliberately NOT absorbing. Un-cancelling back to
 * SCHEDULED/IN_PROGRESS is the ONLY recovery an accidentally cancelled run
 * has: `deleteRun` refuses any run with a recorded deliveryMutation and
 * reopenStop refuses a cancelled run. Since F11 a cancel RELEASES the
 * undelivered orders (their `routeRunStopId` is nulled inside the cancel
 * transaction, so a fresh dispatch re-collects them); un-cancel is a
 * status-only restore that re-pins nothing. Un-cancel stays legal as the
 * non-destructive recovery for the RUN itself (its completed stops' POD and
 * settlement) — it does NOT bring the released orders back onto the run, and
 * `createRun` refuses a route that already carries a SCHEDULED/IN_PROGRESS
 * run, so re-dispatching those orders means cancelling this run again and
 * dispatching a fresh one. Restricting WHO may un-cancel is
 * `updateRunStatus`'s job (drivers may not); the matrix stays role-agnostic.
 *
 * Same-status writes stay allowed so offline retries remain idempotent.
 * Returns the rejection reason, or null when the transition may proceed.
 */
export function forbiddenRunTransition(from: RouteRunStatus, to: RouteRunStatus): string | null {
  if (from === to) return null;
  if (from === RouteRunStatus.CANCELLED && to === RouteRunStatus.COMPLETED) {
    return "This run is cancelled — restart it before marking it completed.";
  }
  if (from === RouteRunStatus.COMPLETED && to === RouteRunStatus.SCHEDULED) {
    return "This run is completed — it cannot go back to scheduled. Reopen a stop instead.";
  }
  return null;
}
