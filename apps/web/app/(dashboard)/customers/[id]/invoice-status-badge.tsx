import * as React from "react";
import { InvoiceStatusText } from "@/lib/invoice-status-display";

/**
 * Row 325 (BT-5): the customer page's invoice status badge. W-1470: a thin call into the shared invoice status view
 * (`lib/invoice-status-display.tsx`), the one rule staff screens use. "Overdue" is the SERVER's one rule (`isOverdue`, the
 * due day ended in the tenant's zone, row 318c) or a stored OVERDUE; the day counts are whole calendar days against the
 * TENANT's day (`useTenantToday`), never the browser's clock. While the zone is unknown the badge claims no day count.
 */
export function renderInvoiceStatus(
  status: string,
  dueDate?: string | null,
  ctx: { isOverdue?: boolean; tenantDay?: string } = {},
): React.ReactNode {
  return (
    <InvoiceStatusText
      status={status}
      dueDate={dueDate}
      isOverdue={ctx.isOverdue}
      tenantDay={ctx.tenantDay}
    />
  );
}
