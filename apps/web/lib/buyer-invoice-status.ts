import type { InvoiceStatus } from "@routeflow/types";
import type { BadgeVariant } from "@routeflow/ui/web";

/**
 * The pill tone for a buyer-visible invoice status (B1122 fold, L-072). Keyed on the shared
 * `InvoiceStatus` enum, never on hand-typed strings: the switch is exhaustive, so adding a
 * status to `INVOICE_STATUS_VALUES` fails type-check here until it gets a deliberate tone.
 */
export function invoiceStatusVariant(status: InvoiceStatus): BadgeVariant {
  switch (status) {
    case "PAID":
      return "success";
    case "PARTIAL":
      return "warning";
    case "OVERDUE":
      return "danger";
    case "VIEWED":
      return "info";
    case "DRAFT":
    case "SENT":
    case "VOID":
    case "WRITTEN_OFF":
      return "neutral";
    default: {
      // Compile-time only: an unmapped enum value makes `status` non-`never` here.
      const unmapped: never = status;
      void unmapped;
      // A server value this build does not know yet still renders, in the neutral tone.
      return "neutral";
    }
  }
}
