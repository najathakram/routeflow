import { API_ERROR_CODES } from "@routeflow/types";
import { formatCaseStepperSplit, isUnitAwareLine, type ShortPickLine } from "@routeflow/pricing";
import { isReadOnlyRefusal, readOnlyRefusalCopy } from "./read-only-refusal";

/**
 * SA-1098 PR-2: what the driver reads when a stop completion (or Undo, or Start/Finish route) is refused. One table, so the sheet
 * never shows a raw server string (B986: the server's own text is read for classification only, never rendered). A 400 is a
 * refusal with no code (a quantity that no longer fits, a stop already done): the sheet answers with fixed words, and the mutation
 * hooks reload the run, so the refreshed "Left to deliver" on each line carries the number.
 */
export interface StopErrorCopy {
  text: string;
}

const KEY_CONFLICT = "IDEMPOTENCY_KEY_CONFLICT";

export const STOP_KEY_CONFLICT_COPY =
  "This stop was already completed with different quantities. Check the stop before you change anything.";
export const STOP_REGULATED_COPY = "This stop needs a signature and an ID check. Call your office.";
/** A lost answer (no response, a 5xx): the stop may or may not have been recorded, so the line says that and nothing else. */
export const STOP_GENERIC_COPY =
  "We couldn't confirm that went through. Check the stop, then try again.";
export const STOP_MOVED_COPY = "This stop changed. The list is up to date now.";
export const STOP_REOPENED_COPY = "This stop was reopened. Check it and record it again.";
export const STOP_BUSY_COPY = "The office is updating this order. Try again in a moment.";
export const STOP_NOT_ACCEPTED_COPY =
  "That was not accepted. The list is up to date now. Check the stop and try again.";
export const STOP_UNDO_REFUSED_COPY = "This stop can't be undone here. Ask your office.";
/** SA-1101 A-4: Undo refused with 409 ORDER_HAS_RETURN. The same sentence the server sends, fixed here (B986: never rendered from the response). */
export const STOP_UNDO_HAS_RETURN_COPY =
  "An order on this stop has a return. To undo the stop, cancel the return first.";
export const RUN_CANNOT_FINISH_COPY =
  "This route can't be finished yet. Check its stops, then try again.";

type Shape = { response?: { status?: number; data?: { code?: unknown } } };

export function stopErrorCopy(err: unknown): StopErrorCopy {
  const res = (err as Shape | null)?.response;
  const status = res?.status;
  const code = res?.data?.code;

  // A READ_ONLY workspace refuses every write with a 403: say so before the generic 403 "stop changed" line below.
  if (status === 403 && isReadOnlyRefusal(err)) {
    return { text: readOnlyRefusalCopy() };
  }
  if (!res || status === undefined || status >= 500) {
    if (status === 503 && code === API_ERROR_CODES.LOCK_UNAVAILABLE) {
      return { text: STOP_BUSY_COPY };
    }
    return { text: STOP_GENERIC_COPY };
  }
  if (code === KEY_CONFLICT) return { text: STOP_KEY_CONFLICT_COPY };
  if (code === API_ERROR_CODES.REGULATED_POD_REQUIRED) {
    return { text: STOP_REGULATED_COPY };
  }
  if (status === 409 && code === API_ERROR_CODES.MERGE_IN_PROGRESS) {
    return { text: STOP_BUSY_COPY };
  }
  if (status === 409 && code === API_ERROR_CODES.STOP_REOPENED) {
    // A kept key met a stop someone reopened: the server wrote nothing, the key is released, and the next tap is a new request.
    return { text: STOP_REOPENED_COPY };
  }
  if (status === 409 || status === 403 || status === 404) {
    // A lost race (STOP_ALREADY_COMPLETED or a 409 with no code), a run that is not in progress or not this driver's.
    return { text: STOP_MOVED_COPY };
  }
  if (status === 400) return { text: STOP_NOT_ACCEPTED_COPY };
  return { text: STOP_GENERIC_COPY };
}

/** Undo: a 400 means a payment is recorded against the stop or its orders moved off the route; either way the office fixes it. */
export function stopUndoErrorCopy(err: unknown): StopErrorCopy {
  const res = (err as Shape | null)?.response;
  if (res?.status === 400) {
    return { text: STOP_UNDO_REFUSED_COPY };
  }
  if (res?.status === 409 && res.data?.code === API_ERROR_CODES.ORDER_HAS_RETURN) {
    return { text: STOP_UNDO_HAS_RETURN_COPY };
  }
  return stopErrorCopy(err);
}

/** What a refused Start route / Finish route reads. Fixed words, never the server's text. */
export function runActionErrorCopy(err: unknown): string {
  const status = (err as Shape | null)?.response?.status;
  if (status === 403 && isReadOnlyRefusal(err)) return readOnlyRefusalCopy();
  if (status === 400) return RUN_CANNOT_FINISH_COPY;
  return STOP_GENERIC_COPY;
}

/**
 * The "Left to deliver" text for one order line, with its unit: a Case line reads "2 Cases + 5 pcs" (the stepper's own words),
 * any other line reads its product unit ("12 lb"), or the number alone when the product stores none (no unit is invented).
 */
export function leftToDeliverText(
  line: Pick<ShortPickLine, "orderedQty" | "unitLabel" | "unitsPerBox">,
  productUnit?: string | null,
): string {
  const left = line.orderedQty;
  if (isUnitAwareLine(line)) {
    const upb = Number(line.unitsPerBox);
    const whole = Math.floor(left / upb);
    return formatCaseStepperSplit(whole, left - whole * upb, line.unitLabel);
  }
  // A factor-1 unit line ("Piece") counts individual pieces, so it reads like a plain line.
  const unit = (productUnit ?? "").trim();
  return unit ? `${left} ${unit}` : String(left);
}
