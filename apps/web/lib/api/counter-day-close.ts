// End-of-day close + Z report (SA-750): the web side of `/orders/counter-sale/day-close`. The shapes are the contract in
// `@routeflow/pricing` (the server imports the same file); the server recomputes every figure, so the form's numbers are a preview.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DayCloseRequest, DayCloseSnapshot, DayCloseState } from "@routeflow/types";
import { API_ERROR_CODES } from "@routeflow/types";
import { apiClient } from "../api-client";

/** Under ["orders"], so a completed counter sale (which invalidates ["orders"]) refreshes "N sales since" with no extra wiring. */
export const COUNTER_DAY_CLOSE_KEY = ["orders", "counter-sale-day-close"] as const;

/** The state of the open window: the last close, the sales since it, and a live preview of the next close. */
export function useCounterDayClose(enabled = true) {
  return useQuery<DayCloseState>({
    queryKey: COUNTER_DAY_CLOSE_KEY,
    queryFn: () =>
      apiClient.get<DayCloseState>("/orders/counter-sale/day-close").then((r) => r.data),
    enabled,
  });
}

/** Close the window (or re-close a reopened one: the same call). The response is the stored snapshot. */
export function useCloseCounterDay() {
  const qc = useQueryClient();
  return useMutation<DayCloseSnapshot, unknown, DayCloseRequest>({
    mutationFn: (req) =>
      apiClient.post<DayCloseSnapshot>("/orders/counter-sale/day-close", req).then((r) => r.data),
    onSuccess: (snapshot) => {
      // show the closed state at once; the refetch below replaces it with the server's own answer
      qc.setQueryData<DayCloseState>(COUNTER_DAY_CLOSE_KEY, (old) =>
        old ? { ...old, lastClose: snapshot, salesSince: 0 } : old,
      );
      void qc.invalidateQueries({ queryKey: COUNTER_DAY_CLOSE_KEY });
    },
  });
}

/** Reopen the latest close. The response is treated as opaque: the state is refetched. */
export function useReopenCounterDay() {
  const qc = useQueryClient();
  return useMutation<unknown, unknown, string>({
    mutationFn: (id) =>
      apiClient
        .post(`/orders/counter-sale/day-close/${encodeURIComponent(id)}/reopen`)
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: COUNTER_DAY_CLOSE_KEY }),
  });
}

/** Send the Z report again. The response is treated as opaque: the state is refetched. */
export function useResendZReport() {
  const qc = useQueryClient();
  return useMutation<unknown, unknown, string>({
    mutationFn: (id) =>
      apiClient
        .post(`/orders/counter-sale/day-close/${encodeURIComponent(id)}/report`)
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: COUNTER_DAY_CLOSE_KEY }),
  });
}

export const DAY_ALREADY_CLOSED_COPY = "Closed on another device.";
export const DAY_CLOSE_FAILED_COPY = "Could not close the day. Check the connection and try again.";
export const DAY_CLOSE_BUSY_COPY = "A sale is finishing. Try again.";
export const DAY_CLOSE_NETWORK_COPY = "Couldn't close the day. Your count is still here.";
export const DAY_REOPENED_CLOSE_AGAIN_COPY = "Day reopened. Close it again.";
export const DAY_OFFLINE_COPY = "You're offline. Your count stays here.";
export const DAY_REOPEN_FAILED_COPY = "Could not reopen the day. Try again.";
export const Z_REPORT_RESEND_FAILED_COPY = "Could not send the report. Try again.";

type ApiErrorShape = { response?: { status?: number; data?: { code?: unknown } } };
const responseOf = (err: unknown) => (err as ApiErrorShape | null | undefined)?.response;

/** 409 DAY_ALREADY_CLOSED: another request closed this window first. */
export function isDayAlreadyClosed(err: unknown): boolean {
  const res = responseOf(err);
  return res?.status === 409 && res.data?.code === API_ERROR_CODES.DAY_ALREADY_CLOSED;
}

/** A 503 or a lock timeout: a sale is mid-flight and holds the window. Retrying is right. */
export function isDayCloseBusy(err: unknown): boolean {
  const res = responseOf(err);
  return res?.status === 503 || res?.data?.code === API_ERROR_CODES.LOCK_UNAVAILABLE;
}

/** No response at all: the request never reached the server (offline, dropped, timed out). */
export function isDayCloseNetworkError(err: unknown): boolean {
  return responseOf(err) == null;
}

/** Fixed copy for a failed close; the server's own message is never shown. */
export function dayCloseErrorCopy(err: unknown): string {
  if (isDayAlreadyClosed(err)) return DAY_ALREADY_CLOSED_COPY;
  if (isDayCloseBusy(err)) return DAY_CLOSE_BUSY_COPY;
  if (isDayCloseNetworkError(err)) return DAY_CLOSE_NETWORK_COPY;
  return DAY_CLOSE_FAILED_COPY;
}
