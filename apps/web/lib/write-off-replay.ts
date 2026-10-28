import { API_ERROR_CODES } from "@routeflow/types";

/**
 * SA-1050 rule 3: a replayed write-off (the first reply was lost, so the staff member tries again) is answered 409
 * INVOICE_ALREADY_WRITTEN_OFF. The invoice IS written off, so the web treats it as done and refetches it.
 */
export function isWriteOffReplay(err: unknown): boolean {
  const res = (err as { response?: { status?: number; data?: { code?: unknown } } } | null)
    ?.response;
  return res?.status === 409 && res.data?.code === API_ERROR_CODES.INVOICE_ALREADY_WRITTEN_OFF;
}
