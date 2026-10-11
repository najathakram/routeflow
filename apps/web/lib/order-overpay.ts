import { roundMoney } from "@routeflow/pricing";
import { API_ERROR_CODES } from "@routeflow/types";
import { fmt } from "./formatting";

/** `409 ORDER_EDIT_WOULD_OVERPAY {invoiceId, paid, projectedTotal, excess}`: the numbers are structured fields, never parsed text. */

export interface OrderOverpayInfo {
  invoiceId: string | null;
  paid: number | null;
  projectedTotal: number | null;
  excess: number | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parseOrderEditWouldOverpay(err: unknown): OrderOverpayInfo | null {
  const res = (err as { response?: { status?: number; data?: Record<string, unknown> } } | null)
    ?.response;
  if (res?.status !== 409 || res.data?.code !== API_ERROR_CODES.ORDER_EDIT_WOULD_OVERPAY)
    return null;
  const d = res.data;
  return {
    invoiceId: typeof d.invoiceId === "string" ? d.invoiceId : null,
    paid: num(d.paid),
    projectedTotal: num(d.projectedTotal),
    excess: num(d.excess),
  };
}

/** Fixed copy: what happened and the next step. The server's own sentence is never shown. */
export function orderOverpayCopy(info: OrderOverpayInfo, canRecordReturn = false): string {
  const lead =
    info.excess !== null && roundMoney(info.excess) > 0
      ? `This change would leave the customer ${fmt(roundMoney(info.excess))} overpaid on the invoice.`
      : "This change would leave the customer overpaid on the invoice.";
  const exit = canRecordReturn ? ", or Record a return for the difference" : "";
  return `${lead} Keep the order total at or above what has been paid${exit}.`;
}

/** Generic copy for the central coded-error map (no number). */
export const ORDER_OVERPAY_GENERIC_COPY = orderOverpayCopy({
  invoiceId: null,
  paid: null,
  projectedTotal: null,
  excess: null,
});
