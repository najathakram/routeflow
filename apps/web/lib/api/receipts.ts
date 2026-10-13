import type { SendReceiptRequest, SendReceiptResponse } from "@routeflow/types";
import { apiClient } from "../api-client";

/**
 * `POST /orders/:id/receipt` (SA-751r): email the receipt of any order with a live invoice to `to`. Resolves when the email
 * LEFT; a failure or a limit is a coded error (see `receiptEmailFailureOf`). The address is the cashier's: it is not saved to the customer.
 */
export async function sendOrderReceiptEmail(
  orderId: string,
  to: string,
): Promise<SendReceiptResponse> {
  const body: SendReceiptRequest = { channel: "email", to };
  const res = await apiClient.post<SendReceiptResponse>(
    `/orders/${encodeURIComponent(orderId)}/receipt`,
    body,
  );
  return res.data;
}
