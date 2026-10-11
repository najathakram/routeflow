import { roundMoney } from "@routeflow/pricing";
import { API_ERROR_CODES } from "@routeflow/types";
import { fmtCurrency } from "../utils/format";

/**
 * P-4: `409 ORDER_EDIT_WOULD_OVERPAY {invoiceId, paid, projectedTotal, excess}` on an order edit save. Pure (no RN imports).
 * The copy is FIXED; numbers come from structured body fields, never the server message. Mirrors apps/web/lib/order-overpay.ts.
 */
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

export const ORDER_OVERPAY_TITLE = "This change would overpay the invoice";

export function orderOverpayCopy(info: OrderOverpayInfo, canRecordReturn = false): string {
  const lead =
    info.excess !== null && roundMoney(info.excess) > 0
      ? `This change would leave the customer ${fmtCurrency(roundMoney(info.excess))} overpaid on the invoice.`
      : "This change would leave the customer overpaid on the invoice.";
  const exit = canRecordReturn ? ", or record a return for the difference" : "";
  return `${lead} Keep the order total at or above what has been paid${exit}.`;
}

/** The existing operator inline-return screen for this order (it takes customerId / orderId / customerName). */
export function orderOverpayReturnRoute(order: {
  id: string;
  customerId?: string | null;
  customerName?: string | null;
}): { pathname: string; params: Record<string, string> } | null {
  if (!order.customerId) return null;
  return {
    pathname: "/(operator)/returns/inline",
    params: {
      customerId: order.customerId,
      orderId: order.id,
      ...(order.customerName ? { customerName: order.customerName } : {}),
    },
  };
}
