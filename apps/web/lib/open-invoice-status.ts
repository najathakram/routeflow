import { OPEN_INVOICE_STATUS_VALUES } from "@routeflow/types";

/**
 * The OPEN invoice statuses (SENT, VIEWED, PARTIAL, OVERDUE: issued and not settled) as a string list
 * for a `statuses` query param. One source: `OPEN_INVOICE_STATUS_VALUES` in `@routeflow/types`, which the
 * API's `OPEN_INVOICE_STATUSES` is pinned set-equal to (invoices/open-invoice-statuses-pin.spec.ts).
 * Never hand-type this list at a call site; common/no-hand-typed-open-invoice-statuses.spec.ts fails on it.
 */
export const OPEN_INVOICE_STATUS_LIST: readonly string[] = OPEN_INVOICE_STATUS_VALUES;

/** True when `status` is one of the shared open invoice statuses. An unknown or missing status is not open. */
export function isOpenInvoiceStatus(status: string | null | undefined): boolean {
  return status != null && OPEN_INVOICE_STATUS_LIST.includes(status);
}
