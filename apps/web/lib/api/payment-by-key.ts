import { apiClient } from "../api-client";

/**
 * SA-824 race ruling 3/5: `POST /invoices/payments/by-key/:key/resolve`, the "Check payment status" call.
 * 200 { state: "found", ... } = the stored payment (current statuses, `replayed: true`, `scope`);
 * 200 { state: "tombstoned" } = nothing was recorded and the key is closed (a late Save is refused);
 * 409 PAYMENT_KEY_IN_FLIGHT = a payment under the key is still committing. Rejects with the HTTP error; the
 * shared holder (`checkStatus`) decides what the answer means (only found / tombstoned release the key).
 */
export function resolvePaymentByKey(key: string): Promise<unknown> {
  return apiClient
    .post(`/invoices/payments/by-key/${encodeURIComponent(key)}/resolve`)
    .then((r) => r.data);
}
