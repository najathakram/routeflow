import { apiClient } from "../api-client";

/**
 * SA-824: `GET /invoices/payments/by-key/:key`, the "Check payment status" read. 200 = the stored payment
 * (current statuses, `replayed: true`, `scope`); 404 PAYMENT_KEY_NOT_FOUND = nothing recorded under the key.
 * Rejects with the HTTP error; the shared holder (`checkStatus`) decides what the answer means.
 */
export function fetchPaymentByKey(key: string): Promise<unknown> {
  return apiClient.get(`/invoices/payments/by-key/${encodeURIComponent(key)}`).then((r) => r.data);
}
