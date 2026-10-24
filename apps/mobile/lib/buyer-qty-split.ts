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

/**
 * Reorder from a past order replays that order's stored `{qty, boxes, pieces}`. When the product's pack size has
 * changed since, the pair no longer agrees under today's pack and the server refuses it (QTY_SPLIT_MISMATCH):
 * the buyer cannot "review the cart" there, so the copy says what happened and where to go instead.
 */
export const BUYER_REORDER_PACK_CHANGED_COPY =
  "Pack sizes changed since this order. Add the items from the catalog.";

/** The reorder failure toast: the pack-changed sentence for the coded refusal, else the screen's old fallback chain. */
export function reorderErrorCopy(err: unknown): string {
  if (isQtySplitMismatch(err)) return BUYER_REORDER_PACK_CHANGED_COPY;
  const e = err as { response?: { data?: { message?: unknown } }; message?: unknown } | null;
  const server = e?.response?.data?.message;
  if (typeof server === "string" && server) return server;
  if (typeof e?.message === "string" && e.message) return e.message;
  return "Try again.";
}
