import * as React from "react";
import { calendarDateFromIso } from "@/lib/calendar-date";
import { daysPastDue } from "@/lib/days-past-due";
import { cn } from "@routeflow/ui/web";

/**
 * Row 325 (BT-5): the customer page's invoice status badge. "Overdue" is the SERVER's one rule (`isOverdue`, the due day
 * ended in the tenant's zone, row 318c) or a stored OVERDUE; the day counts are whole calendar days against the
 * TENANT's day (`useTenantToday`), never the browser's clock. While the zone is unknown the badge claims no day count.
 */
export function renderInvoiceStatus(
  status: string,
  dueDate?: string | null,
  ctx: { isOverdue?: boolean; tenantDay?: string } = {},
): React.ReactNode {
  if (status === "PAID") return <span className="text-xs font-semibold text-green-600">Paid</span>;
  if (status === "VOID") return <span className="text-xs font-semibold text-gray-400">Void</span>;
  if (status === "WRITTEN_OFF")
    return <span className="text-xs font-semibold text-stone-500">Written off</span>;
  if (status === "DRAFT") return <span className="text-xs font-semibold text-gray-500">Draft</span>;

  const { tenantDay } = ctx;
  const due = calendarDateFromIso(dueDate);
  if (due) {
    const days = tenantDay ? daysPastDue(tenantDay, dueDate) : 0;
    const daysUntil =
      tenantDay && /^\d{4}-\d{2}-\d{2}$/.test(tenantDay)
        ? Math.round(
            (Date.parse(`${due}T00:00:00Z`) - Date.parse(`${tenantDay}T00:00:00Z`)) / 86_400_000,
          )
        : null;

    if (status === "OVERDUE" || ctx.isOverdue === true) {
      if (status === "PARTIAL")
        return (
          <span className="text-xs font-semibold text-orange-500">
            Partial · Overdue{days > 0 ? ` by ${days}d` : ""}
          </span>
        );
      return (
        <span className="text-xs font-semibold text-red-600">
          Overdue{days > 0 ? ` by ${days}d` : ""}
        </span>
      );
    }
    if (daysUntil === 0) {
      if (status === "PARTIAL")
        return <span className="text-xs font-semibold text-yellow-600">Partial · Due today</span>;
      return <span className="text-xs font-semibold text-orange-500">Due today</span>;
    }
    if (status === "PARTIAL" && daysUntil != null && daysUntil > 0)
      return (
        <span className="text-xs font-semibold text-yellow-600">Partial · Due in {daysUntil}d</span>
      );
  }

  const colors: Record<string, string> = {
    SENT: "text-blue-600",
    VIEWED: "text-purple-600",
    PARTIAL: "text-yellow-600",
    OVERDUE: "text-red-600",
  };
  const labels: Record<string, string> = {
    SENT: "Sent",
    VIEWED: "Viewed",
    PARTIAL: "Partial",
    OVERDUE: "Overdue",
  };
  return (
    <span className={cn("text-xs font-semibold", colors[status] ?? "text-gray-500")}>
      {labels[status] ?? status}
    </span>
  );
}
