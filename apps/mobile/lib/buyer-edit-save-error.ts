import { API_ERROR_CODES, BUYER_EDIT_DELIVERED_LINES_COPY } from "@routeflow/types";

/**
 * What the buyer reads when an items save fails. SA-1149: a save on an order with a delivered line (409
 * `ORDER_EDIT_DELIVERED_LINES`) shows the one stored buyer sentence, never the server's staff wording; any other failure
 * keeps the server's message.
 */
export function buyerEditSaveError(err: unknown): string {
  const e = err as {
    message?: string;
    response?: { status?: number; data?: { code?: unknown; message?: string } };
  } | null;
  if (
    e?.response?.status === 409 &&
    e.response.data?.code === API_ERROR_CODES.ORDER_EDIT_DELIVERED_LINES
  ) {
    return BUYER_EDIT_DELIVERED_LINES_COPY;
  }
  return e?.response?.data?.message ?? e?.message ?? "Save failed.";
}
