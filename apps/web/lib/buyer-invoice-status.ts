import type { InvoiceStatus } from "@routeflow/types";
import type { BadgeVariant } from "@routeflow/ui/web";
import { invoiceStatusBuyerVariant } from "@/lib/invoice-status-display";

/**
 * The ONE status -> pill tone helper for the buyer invoices LIST and DETAIL pages (B1122 fold, L-072). W-1470: the table
 * now lives in `lib/invoice-status-display.tsx` (keyed on the shared `InvoiceStatus` enum, so a new status fails type-check
 * there until it gets a deliberate tone); this name stays so the two buyer pages import what they always did. Buyer tones
 * are unchanged: SENT and PARTIAL warning, VIEWED info, PAID success, OVERDUE, VOID and WRITTEN_OFF danger, DRAFT neutral.
 */
export function invoiceStatusVariant(status: InvoiceStatus): BadgeVariant {
  return invoiceStatusBuyerVariant(status);
}
