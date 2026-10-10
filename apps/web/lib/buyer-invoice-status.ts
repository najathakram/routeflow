import type { InvoiceStatus } from "@routeflow/types";
import type { BadgeVariant } from "@routeflow/ui/web";

/**
 * The ONE status -> pill tone helper for the buyer invoices LIST and DETAIL pages (B1122 fold,
 * L-072). Tones follow the design-system `Badge` STATUS_MAP (SENT/PARTIAL warning, VIEWED info,
 * PAID success, OVERDUE danger, DRAFT neutral); VOID and WRITTEN_OFF are danger on both pages. Keyed on the shared
 * `InvoiceStatus` enum, never on hand-typed strings: the switch is exhaustive, so adding a
 * status to `INVOICE_STATUS_VALUES` fails type-check here until it gets a deliberate tone.
 */
export function invoiceStatusVariant(status: InvoiceStatus): BadgeVariant {
  switch (status) {
    case "PAID":
      return "success";
    case "PARTIAL":
      return "warning";
    case "SENT":
      return "warning";
    case "OVERDUE":
    case "VOID":
    case "WRITTEN_OFF":
      return "danger";
    case "VIEWED":
      return "info";
    case "DRAFT":
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
