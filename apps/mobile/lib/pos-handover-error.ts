import { API_ERROR_CODES } from "@routeflow/types";
import { counterCompleteRefusalCopy } from "@routeflow/types/counter-copy";
import { fmtCurrency } from "../utils/format";
import { pickupCompleteErrorCopy, posErrorCode } from "./pos-mode";

/**
 * W-813 (SA-932 §W-813, I-120 hand-over). `COUNTER_SALE_DAY_CLOSED` is shared by two states: the read-only pre-check's
 * "nothing changed", and the in-lock refusal after the hand-over committed ("it stands, the payment was not taken"). SA-925
 * gives the pre-check its own code (#3707). Until then, and after it, the phone tells them apart by the order it REFETCHES
 * after the error: DELIVERED means the hand-over stands.
 */
export const HANDED_OVER_DAY_CLOSED_COPY =
  "Handed over. The till day is closed, so the payment was not taken here. Record it in the office.";
/** SA-932's not-delivered line; `counterCompleteRefusalCopy` owns it once SA-925's code lands (#3707). */
export const DAY_CLOSED_NOTHING_CHANGED_COPY = "Nothing changed. The till day is closed.";

const DAY_CLOSED_CODES: readonly string[] = [
  API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED,
  "COUNTER_COMPLETE_DAY_CLOSED", // SA-925 (#3707): the pre-check's own code, not yet in API_ERROR_CODES on master
];

export interface HandOverErrorOutcome {
  message: string;
  /** true = the refetched order is DELIVERED: close the sheet; the hand-over stands. */
  handedOver: boolean;
}

/** The copy and the sheet's next step for a failed hand-over, judged on the order as REFETCHED after the error. */
export function handOverErrorOutcome(
  err: unknown,
  refreshedStatus: string | null,
  complete: boolean,
): HandOverErrorOutcome {
  const code = posErrorCode(err);
  if (code && DAY_CLOSED_CODES.includes(code)) {
    if (refreshedStatus === "DELIVERED")
      return { message: HANDED_OVER_DAY_CLOSED_COPY, handedOver: true };
    const data = (err as { response?: { data?: Record<string, unknown> } } | null)?.response?.data;
    return {
      message: counterCompleteRefusalCopy(data, fmtCurrency) ?? DAY_CLOSED_NOTHING_CHANGED_COPY,
      handedOver: false,
    };
  }
  return { message: pickupCompleteErrorCopy(err, complete), handedOver: false };
}

/** Web PickupCompleteDialog parity: a known 4xx answer releases the held Idempotency-Key; a 5xx or no answer keeps it. */
export function releasesHandOverKey(err: unknown): boolean {
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  return status !== undefined && status >= 400 && status < 500;
}
