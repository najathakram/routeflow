import { API_ERROR_CODES } from "@routeflow/types";

export const BULK_CANCEL_GENERIC_FAILURE = "Failed to cancel some orders";

const isWithCarrier = (err: unknown): boolean =>
  (err as { response?: { data?: { code?: unknown } } } | null | undefined)?.response?.data?.code ===
  API_ERROR_CODES.ORDER_WITH_CARRIER_NO_CANCEL;

/**
 * The orders list's bulk Cancel runs one request per order. Orders the server refuses with
 * ORDER_WITH_CARRIER_NO_CANCEL (the parcel is with the carrier; a return, not a cancel) get their own
 * message with a count instead of the generic failure. `failures` = the rejected reasons, one per order.
 */
export function bulkCancelFailureTitle(failures: readonly unknown[]): string {
  const carrier = failures.filter(isWithCarrier).length;
  if (carrier === 0) return BULK_CANCEL_GENERIC_FAILURE;
  const head =
    carrier === 1
      ? "1 order is with the carrier and can't be cancelled"
      : `${carrier} orders are with the carrier and can't be cancelled`;
  const rest = failures.length - carrier;
  if (rest === 0) return head;
  return `${head}; ${rest} ${rest === 1 ? "other" : "others"} failed to cancel`;
}
