import { apiClient } from "../api-client";
import { paymentByKeyPath } from "../payment-status-check";

/** SA-824: the "Check payment status" read (see `payment-status-check.ts`); rejects with the HTTP error. */
export const fetchPaymentByKey = (key: string): Promise<unknown> =>
  apiClient.get(paymentByKeyPath(key)).then((r) => r.data);
