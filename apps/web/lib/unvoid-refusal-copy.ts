import {
  API_ERROR_CODES,
  ORDER_BILLING_CHANGED_REASONS,
  UNVOID_BILLING_COPY,
} from "@routeflow/types";

type Refusal = { response?: { status?: number; data?: { code?: unknown; reason?: unknown } } };

/**
 * SA-814d: the fixed copy for a refused unvoid (409 ORDER_BILLING_CHANGED), chosen by the body's `reason`, never by
 * matching the message. Null = no known reason (a race refusal, another error): the caller keeps its own copy.
 */
export function unvoidRefusalCopy(err: unknown): string | null {
  const res = (err as Refusal | null | undefined)?.response;
  if (res?.status !== 409 || res.data?.code !== API_ERROR_CODES.ORDER_BILLING_CHANGED) return null;
  const reason = res.data.reason;
  if (reason === ORDER_BILLING_CHANGED_REASONS.OTHER_INVOICE)
    return UNVOID_BILLING_COPY.OTHER_INVOICE;
  if (reason === ORDER_BILLING_CHANGED_REASONS.LINE_REDUCED)
    return UNVOID_BILLING_COPY.LINE_REDUCED;
  return null;
}
