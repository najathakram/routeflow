import * as React from "react";
import {
  INVOICE_STATUS_BUYER_TONE,
  INVOICE_STATUS_LABEL,
  INVOICE_STATUS_LEGEND,
  invoiceStatusTone,
  type InvoiceStatus,
  type InvoiceStatusTone,
} from "@routeflow/types";
import { cn, type BadgeVariant } from "@routeflow/ui/web";
import { calendarDateFromIso } from "@/lib/calendar-date";
import { daysPastDue } from "@/lib/days-past-due";
import { calendarDaysUntil } from "@/lib/formatting";

/**
 * W-1470: the ONE web reading of an invoice status. `@routeflow/types` owns the table (tone and words per status); this
 * file turns a tone into a class or a Badge variant and reads the due date. No other web file keys an invoice status to a
 * colour (pinned by `invoice-status-one-rule.static.test.ts`).
 *
 * The rule (row 325, BT-5, moved here from the customer badge): "overdue" is the SERVER's one rule (`isOverdue`, the due
 * day ended in the tenant's zone) or a stored OVERDUE. Day counts are whole calendar days against the TENANT's day
 * (`useTenantToday`), never the browser's clock; while the tenant's day is unknown no day count is claimed.
 */

/** Tone to a text colour class (list rows, customer page). */
export const INVOICE_STATUS_TEXT_CLASS: Record<InvoiceStatusTone, string> = {
  neutral: "text-navy/50",
  info: "text-brand-600",
  warning: "text-warning",
  danger: "text-danger",
  success: "text-success",
  muted: "text-navy/40",
  stone: "text-stone-500",
};

/** Tone to a pill (background and text) class (finance reports). */
export const INVOICE_STATUS_PILL_CLASS: Record<InvoiceStatusTone, string> = {
  neutral: "bg-gray-100 text-gray-600",
  info: "bg-blue-100 text-blue-700",
  warning: "bg-amber-100 text-amber-700",
  danger: "bg-red-100 text-red-700",
  success: "bg-green-100 text-green-700",
  muted: "bg-gray-100 text-gray-400",
  stone: "bg-stone-100 text-stone-600",
};

/** Tone to a design-system Badge variant. */
export const INVOICE_STATUS_BADGE_VARIANT: Record<InvoiceStatusTone, BadgeVariant> = {
  neutral: "neutral",
  info: "info",
  warning: "warning",
  danger: "danger",
  success: "success",
  muted: "neutral",
  stone: "neutral",
};

/** The buyer portal's Badge variant per status, from the shared buyer tone table (B1122, unchanged by W-1470). */
export function invoiceStatusBuyerVariant(status: InvoiceStatus): BadgeVariant {
  const tone = (INVOICE_STATUS_BUYER_TONE as Record<string, InvoiceStatusTone | undefined>)[status];
  return tone ? INVOICE_STATUS_BADGE_VARIANT[tone] : "neutral";
}

export interface InvoiceStatusView {
  label: string;
  tone: InvoiceStatusTone;
}

export interface InvoiceStatusContext {
  /** The server's overdue flag (`Invoice.isOverdue`). */
  isOverdue?: boolean;
  /** The tenant's day, YYYY-MM-DD (`useTenantToday`); undefined while the zone loads. */
  tenantDay?: string;
}

const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/** Statuses whose word never carries a due count (settled, voided, written off or not yet sent). */
const NO_DUE_WORDING: Record<InvoiceStatus, boolean> = {
  DRAFT: true,
  SENT: false,
  VIEWED: false,
  PARTIAL: false,
  PAID: true,
  OVERDUE: false,
  VOID: true,
  WRITTEN_OFF: true,
};

/** The word and the tone a staff screen shows for an invoice. */
export function invoiceStatusView(
  status: string,
  dueDate?: string | null,
  ctx: InvoiceStatusContext = {},
): InvoiceStatusView {
  const known = (INVOICE_STATUS_LABEL as Record<string, string | undefined>)[status];
  const plain: InvoiceStatusView = { label: known ?? status, tone: invoiceStatusTone(status) };
  if ((NO_DUE_WORDING as Record<string, boolean | undefined>)[status]) return plain;

  const { tenantDay } = ctx;
  const due = calendarDateFromIso(dueDate);
  if (!due) return plain;

  const hasDay = !!tenantDay && /^\d{4}-\d{2}-\d{2}$/.test(tenantDay);
  const late = hasDay ? daysPastDue(tenantDay, dueDate) : 0;
  const daysUntil = hasDay
    ? Math.round(
        (Date.parse(`${due}T00:00:00Z`) - Date.parse(`${tenantDay}T00:00:00Z`)) / 86_400_000,
      )
    : null;

  if (status === "OVERDUE" || ctx.isOverdue === true) {
    const count = late > 0 ? ` by ${days(late)}` : "";
    return {
      label: status === "PARTIAL" ? `Partial · Overdue${count}` : `Overdue${count}`,
      tone: "danger",
    };
  }
  if (daysUntil === 0) {
    return { label: status === "PARTIAL" ? "Partial · Due today" : "Due today", tone: "warning" };
  }
  if (status === "PARTIAL" && daysUntil != null && daysUntil > 0) {
    return { label: `Partial · Due in ${days(daysUntil)}`, tone: "warning" };
  }
  return plain;
}

/** A staff status as coloured text (the invoices list, the customer page). */
export function InvoiceStatusText({
  status,
  dueDate,
  isOverdue,
  tenantDay,
}: { status: string; dueDate?: string | null } & InvoiceStatusContext) {
  const { label, tone } = invoiceStatusView(status, dueDate, { isOverdue, tenantDay });
  return (
    <span
      data-invoice-status={status}
      data-tone={tone}
      className={cn("text-xs font-semibold", INVOICE_STATUS_TEXT_CLASS[tone])}
    >
      {label}
    </span>
  );
}

/**
 * R-356 F1 (lead ruling 7210882888, AC9): a CUSTOMER signed in to the dashboard list sees exactly what master showed
 * them: the browser's day (they cannot read the tenant zone), no server overdue flag on Sent or Viewed, and master's
 * colours (Viewed brand-700, Written off navy/50). Staff screens use `invoiceStatusView`; this one is frozen until
 * the owner rules on a change for customers.
 */
export function customerListStatusView(
  status: string,
  dueDate?: string | null,
): { label: string; className: string } {
  const plural = (n: number) => `${n} day${n !== 1 ? "s" : ""}`;
  if (status === "PAID") return { label: "Paid", className: "text-success" };
  if (status === "VOID") return { label: "Void", className: "text-navy/40" };
  if (status === "WRITTEN_OFF") return { label: "Written off", className: "text-navy/50" };
  if (status === "DRAFT") return { label: "Draft", className: "text-navy/50" };
  if (status === "SENT") return { label: "Sent", className: "text-brand-600" };
  if (status === "VIEWED") return { label: "Viewed", className: "text-brand-700" };
  const partial = status === "PARTIAL";
  const diff = calendarDaysUntil(dueDate);
  if (diff === null) {
    if (partial) return { label: "Partial", className: "text-warning" };
    if (status === "OVERDUE") return { label: "Overdue", className: "text-danger" };
    return { label: status, className: "text-navy/50" };
  }
  if (status === "OVERDUE" || diff < 0) {
    const late = Math.abs(diff);
    const by = late > 0 ? ` by ${plural(late)}` : "";
    return { label: `${partial ? "Partial · Overdue" : "Overdue"}${by}`, className: "text-danger" };
  }
  if (diff === 0) {
    return { label: partial ? "Partial · Due today" : "Due today", className: "text-warning" };
  }
  return partial
    ? { label: `Partial · Due in ${plural(diff)}`, className: "text-warning" }
    : { label: `Due in ${plural(diff)}`, className: "text-brand-600" };
}

/** The customer list cell: master's words and colours (see `customerListStatusView`). */
export function CustomerInvoiceStatusText({
  status,
  dueDate,
}: {
  status: string;
  dueDate?: string | null;
}) {
  const { label, className } = customerListStatusView(status, dueDate);
  return (
    <span data-invoice-status={status} className={cn("text-xs font-semibold", className)}>
      {label}
    </span>
  );
}

/** A stored status as a pill (the finance reports): the stored word and tone, no due-date reading. */
export function InvoiceStatusPill({ status }: { status: string }) {
  const { label, tone } = invoiceStatusView(status);
  return (
    <span
      data-invoice-status={status}
      data-tone={tone}
      className={cn(
        "rounded-full px-2 py-0.5 text-xs font-medium",
        INVOICE_STATUS_PILL_CLASS[tone],
      )}
    >
      {label}
    </span>
  );
}

/** The status key: each status once, in enum order, in the same tone. */
export function InvoiceStatusLegend({ className }: { className?: string }) {
  return (
    <ul
      aria-label="Invoice status key"
      className={cn("flex flex-wrap items-center gap-x-4 gap-y-1", className)}
    >
      {INVOICE_STATUS_LEGEND.map((row) => (
        <li
          key={row.status}
          data-legend-status={row.status}
          data-tone={row.tone}
          className={cn("text-xs font-semibold", INVOICE_STATUS_TEXT_CLASS[row.tone])}
        >
          {row.label}
        </li>
      ))}
    </ul>
  );
}
