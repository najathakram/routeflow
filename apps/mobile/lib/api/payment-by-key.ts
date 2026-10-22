import { apiClient } from "../api-client";
import { paymentResolvePath } from "../payment-status-check";

/** SA-824: the "Check payment status" resolve (see `payment-status-check.ts`); rejects with the HTTP error. */
export const resolvePaymentByKey = (key: string): Promise<unknown> =>
  apiClient.post(paymentResolvePath(key)).then((r) => r.data);
