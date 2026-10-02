import { API_ERROR_CODES } from "@routeflow/types";

/**
 * B917: GET /orders answers a CUSTOMER login that has no live Customer record with a 403 whose
 * `body.code` is CUSTOMER_NOT_LINKED (REG-B131 refusal, unchanged status). The dashboard maps it to a
 * fixed sentence that says what to do instead of the generic load failure; the server message is
 * never shown.
 */
export const CUSTOMER_NOT_LINKED_COPY =
  "Your account isn't linked to a business yet. Contact your supplier.";

export function isCustomerNotLinked(error: unknown): boolean {
  const res = (error as { response?: { status?: number; data?: { code?: unknown } } })?.response;
  return res?.status === 403 && res.data?.code === API_ERROR_CODES.CUSTOMER_NOT_LINKED;
}
