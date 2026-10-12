/**
 * Row 262 (mobile half of the order revision guard; web reference: OrderStaleNotice.tsx).
 *
 * The order editor sends the `revisionNumber` it loaded when edit mode OPENED as
 * `expectedRevisionNumber`; behind the server's latest, PATCH /orders/:id/items answers
 * 409 ORDER_REVISION_STALE. This module is the pure decision layer: which error is the stale
 * one, what the user is told (fixed copy, never the server's sentence), which revision the
 * editor holds, and what goes on the wire.
 */
import { API_ERROR_CODES } from "@routeflow/types";

/** Fixed copy: what happened and the next step. */
export const ORDER_STALE_COPY = "This order changed since you opened it. Reload to see the latest.";

export function isOrderRevisionStale(err: unknown): boolean {
  const res = (err as { response?: { status?: number; data?: { code?: unknown } } } | null)
    ?.response;
  return res?.status === 409 && res.data?.code === API_ERROR_CODES.ORDER_REVISION_STALE;
}

const known = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

/** Revision at the moment edit mode opened: set once, never moved by a background refetch. */
export function captureOpenRevision(
  captured: number | undefined,
  live: number | undefined,
): number | undefined {
  if (known(captured)) return captured;
  return known(live) ? live : undefined;
}

/** After an explicit reload the editor is judged against the freshly loaded revision. */
export function rebaseRevision(fresh: number | undefined): number | undefined {
  return known(fresh) ? fresh : undefined;
}

/** Spread into the PATCH body: `expectedRevisionNumber` only when known. */
export function expectedRevisionBody(rev: number | undefined): { expectedRevisionNumber?: number } {
  return known(rev) ? { expectedRevisionNumber: rev } : {};
}
