import { API_ERROR_CODES } from "@routeflow/types";

/**
 * Row 531: the server refuses a buyer order whose `qty` and `boxes`/`pieces` split disagree for a
 * boxed product (a coded 400, nothing saved). The buyer-facing sentence is FIXED, never the
 * server's message. Same sentence as web's `BUYER_QTY_SPLIT_MISMATCH_COPY` (apps/web/lib/
 * buyer-cart-line.ts); each app keeps its own literal and a test pins it.
 */
export const BUYER_QTY_SPLIT_MISMATCH_COPY =
  "Your cart changed. Review the quantities and try again.";

/** True when `err` is the coded QTY_SPLIT_MISMATCH 400. */
export function isQtySplitMismatch(err: unknown): boolean {
  const res = (err as { response?: { status?: number; data?: { code?: unknown } } } | null)
    ?.response;
  return res?.status === 400 && res.data?.code === API_ERROR_CODES.QTY_SPLIT_MISMATCH;
}
