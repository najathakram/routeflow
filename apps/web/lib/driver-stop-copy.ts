import { API_ERROR_CODES } from "@routeflow/types";

/**
 * SA-1098 PR-2: what the driver reads when a stop completion (or Undo, or Start/Finish route) is refused. One table, so the sheet
 * never shows a raw server string it did not choose. A 400 is the server's own fit refusal ("only 7 left") and is shown as sent.
 * `refresh` tells the screen to reload the run (the stop moved under the driver); `retry` keeps the same key and offers Try again.
 */
export interface StopErrorCopy {
  message: string;
  refresh: boolean;
  retry: boolean;
}

const KEY_CONFLICT = "IDEMPOTENCY_KEY_CONFLICT";

export const STOP_KEY_CONFLICT_COPY =
  "This stop was already completed with different quantities. Check the stop before you change anything.";
export const STOP_REGULATED_COPY = "This stop needs a signature and an ID check. Call your office.";
export const STOP_GENERIC_COPY = "That did not go through. Check your connection and try again.";
export const STOP_MOVED_COPY = "This stop changed. The list is up to date now.";
export const STOP_REOPENED_COPY = "This stop was reopened. Check it and record it again.";
export const STOP_BUSY_COPY = "The office is updating this order. Try again in a moment.";

type Shape = { response?: { status?: number; data?: { code?: unknown; message?: unknown } } };

export function stopErrorCopy(err: unknown): StopErrorCopy {
  const res = (err as Shape | null)?.response;
  const status = res?.status;
  const code = res?.data?.code;
  const server = typeof res?.data?.message === "string" ? res.data.message : null;

  if (!res || status === undefined || status >= 500) {
    if (status === 503 && code === API_ERROR_CODES.LOCK_UNAVAILABLE) {
      return { message: STOP_BUSY_COPY, refresh: false, retry: true };
    }
    return { message: STOP_GENERIC_COPY, refresh: false, retry: true };
  }
  if (code === KEY_CONFLICT)
    return { message: STOP_KEY_CONFLICT_COPY, refresh: true, retry: false };
  if (code === API_ERROR_CODES.REGULATED_POD_REQUIRED) {
    return { message: STOP_REGULATED_COPY, refresh: false, retry: false };
  }
  if (status === 409 && code === API_ERROR_CODES.MERGE_IN_PROGRESS) {
    return { message: STOP_BUSY_COPY, refresh: false, retry: true };
  }
  if (status === 409 && code === API_ERROR_CODES.STOP_REOPENED) {
    // A kept key met a stop someone reopened: the server wrote nothing, the key is released, and the next tap is a new request.
    return { message: STOP_REOPENED_COPY, refresh: true, retry: false };
  }
  if (status === 409 || status === 403 || status === 404) {
    // A lost race (STOP_ALREADY_COMPLETED or a 409 with no code), a run that is not in progress or not this driver's.
    return { message: STOP_MOVED_COPY, refresh: true, retry: false };
  }
  if (status === 400 && server) return { message: server, refresh: false, retry: false };
  return { message: STOP_GENERIC_COPY, refresh: false, retry: false };
}
