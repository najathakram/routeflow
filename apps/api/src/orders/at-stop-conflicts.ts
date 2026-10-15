import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * B796: the human `message` for each at-stop refusal of approveChangeRequestAtStop. The `code` (and
 * `reason`) is the contract clients branch on and is unchanged; the `message` is what a person
 * reads — B790's decline reason and the driver's toast. Without one, those fell back to axios's
 * "Request failed with status code 409".
 *
 * Keyed `CODE` or `CODE:REASON`. Each message says what to do next where there is a next step:
 * a completed or skipped stop means the at-door authority window is over, so the request is
 * resolved as next-delivery instead (or declined).
 */
export const CHANGE_WINDOW_ORDER_STATUS =
  `${API_ERROR_CODES.CHANGE_WINDOW_CLOSED}:ORDER_STATUS` as const;
export const CHANGE_WINDOW_RUN_NOT_ACTIVE =
  `${API_ERROR_CODES.CHANGE_WINDOW_CLOSED}:RUN_NOT_ACTIVE` as const;

export const AT_STOP_CONFLICT_MESSAGES = {
  [CHANGE_WINDOW_ORDER_STATUS]: "This order is no longer open for changes at the stop.",
  [CHANGE_WINDOW_RUN_NOT_ACTIVE]:
    "This order's delivery run isn't in progress, so the change can't be applied at the stop.",
  [API_ERROR_CODES.STOP_ALREADY_COMPLETED]:
    "This stop is already completed or skipped. Approve the request for the next delivery, or decline it.",
} as const;

export type AtStopConflict = keyof typeof AT_STOP_CONFLICT_MESSAGES;

/** The 409 for one at-stop refusal: `{ code, reason?, message }`. */
export function atStopConflict(kind: AtStopConflict): ConflictException {
  const [code, reason] = kind.split(":");
  return new ConflictException({
    code,
    ...(reason ? { reason } : {}),
    message: AT_STOP_CONFLICT_MESSAGES[kind],
  });
}
