// SA-1263 A1 (W-1335): the ONE table of estimate state moves. Each action lists the statuses it may start from; the
// api claims `status: { in: ESTIMATE_MOVES[action] }`, and web and mobile read the same table. A status nobody listed
// has no moves, so a new enum value is closed by default (an allowlist, never a denylist).
import type { EstimateStatus } from "./enums";

export const ESTIMATE_ACTION_VALUES = [
  "edit",
  "send",
  "accept",
  "decline",
  "void",
  "revert",
  "convert",
] as const;
export type EstimateAction = (typeof ESTIMATE_ACTION_VALUES)[number];

/**
 * Action -> the statuses it may start from. Every cell is master's answer at 0762a57ee4 except the ones SA-1263 names:
 * DECLINED -> ACCEPTED is closed (a void is stored as DECLINED, so it was the void-to-invoice path), and VOID has no
 * moves. DECLINED -> VOID and DECLINED -> DRAFT open in A2, not here.
 */
export const ESTIMATE_MOVES: Readonly<Record<EstimateAction, readonly EstimateStatus[]>> = {
  edit: ["DRAFT"],
  send: ["DRAFT", "SENT", "ACCEPTED"],
  accept: ["DRAFT", "SENT", "ACCEPTED"],
  decline: ["DRAFT", "SENT", "ACCEPTED"],
  void: ["DRAFT", "SENT", "ACCEPTED"],
  revert: ["SENT", "ACCEPTED"],
  convert: ["ACCEPTED"],
};

/** Absorbing: no action starts from these. CONVERTED has an invoice; VOID is the business closing the quote. */
export const TERMINAL_ESTIMATE_STATUSES = [
  "CONVERTED",
  "VOID",
] as const satisfies readonly EstimateStatus[];

export function canMoveEstimate(
  status: string | null | undefined,
  action: EstimateAction,
): boolean {
  return (ESTIMATE_MOVES[action] as readonly string[]).includes(status ?? "");
}

/**
 * "Rev 2": shown once a sent quote has gone back to draft and been sent again. Never on a DRAFT (it is mid-edit) and
 * never at revision 1. A re-send does not change it (the revert claim is the only writer). Null = show nothing.
 */
export function estimateRevisionTag(
  status: string | null | undefined,
  revision: number | null | undefined,
): string | null {
  return status !== "DRAFT" && (revision ?? 1) > 1 ? `Rev ${revision}` : null;
}

/**
 * The one line a closed estimate shows in place of its actions (SA-1263 wording). A DECLINED row never names the
 * customer: old rows include voids, which are stored as DECLINED until A2. Null = the estimate is not closed.
 */
export function estimateClosedLine(status: string | null | undefined): string | null {
  if (status === "DECLINED") return "Declined. This estimate is closed.";
  if (status === "VOID") return "Voided. This estimate is closed.";
  return null;
}
