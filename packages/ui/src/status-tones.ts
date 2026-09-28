/**
 * The ONE status → tone map (#2332, plan §2.3 / §5 R2). Native `Badge` (`./native/Badge.tsx`)
 * reads it; web `Badge` will consume it via #2332b. Plain data only: no platform code.
 *
 * `BadgeStatus` is DERIVED from the Prisma-enum mirrors in `@routeflow/types` (the L-072 rule: a
 * hand-typed mirror of a server enum drifts), plus the few UI-only statuses below. `STATUS_TONES`
 * is typed over the whole union, so a new enum value without a tone fails the type-check.
 */
import {
  CREDIT_NOTE_STATUS_VALUES,
  ESTIMATE_STATUS_VALUES,
  INVOICE_STATUS_VALUES,
  ORDER_STATUS_VALUES,
  PAYMENT_STATUS_VALUES,
  RETURN_STATUS_VALUES,
  ROUTE_RUN_STATUS_VALUES,
  ROUTE_RUN_STOP_STATUS_VALUES,
} from "@routeflow/types/api/enums";
import { ledgerInk, ledgerStatus, ledgerSurface } from "./tokens/ledger";

/** The five badge tones (web `BadgeVariant`). */
export type BadgeVariant = "success" | "warning" | "danger" | "info" | "neutral";

export interface StatusToneEntry {
  variant: BadgeVariant;
  label: string;
}

/** The server enums a badge renders, each pinned to `@prisma/client` by enum-parity.spec. */
export const BADGE_ENUMS = {
  order: ORDER_STATUS_VALUES,
  invoice: INVOICE_STATUS_VALUES,
  return: RETURN_STATUS_VALUES,
  estimate: ESTIMATE_STATUS_VALUES,
  creditNote: CREDIT_NOTE_STATUS_VALUES,
  payment: PAYMENT_STATUS_VALUES,
  routeRun: ROUTE_RUN_STATUS_VALUES,
  routeRunStop: ROUTE_RUN_STOP_STATUS_VALUES,
} as const;

/**
 * Statuses a badge shows that are not a value of those enums: account states, payment kinds and
 * derived display states.
 */
export const UI_ONLY_STATUS_VALUES = [
  "ACTIVE",
  "INACTIVE",
  "SUSPENDED",
  "PROCESSING",
  "FAILED",
  "RETURNED",
  "EXPIRED",
  "ADVANCE",
  "CREDIT_NOTE",
] as const;

export type BadgeStatus =
  (typeof BADGE_ENUMS)[keyof typeof BADGE_ENUMS][number] | (typeof UI_ONLY_STATUS_VALUES)[number];

export const STATUS_TONES: Record<BadgeStatus, StatusToneEntry> = {
  DRAFT: { variant: "neutral", label: "Draft" },
  ACTIVE: { variant: "success", label: "Active" },
  INACTIVE: { variant: "neutral", label: "Inactive" },
  SUSPENDED: { variant: "danger", label: "Suspended" },
  PENDING: { variant: "warning", label: "Pending" },
  CONFIRMED: { variant: "info", label: "Confirmed" },
  OUT_FOR_DELIVERY: { variant: "info", label: "Out for Delivery" },
  PARTIALLY_DELIVERED: { variant: "warning", label: "Partially Delivered" },
  DELIVERED: { variant: "success", label: "Delivered" },
  CANCELLED: { variant: "danger", label: "Cancelled" },
  SCHEDULED: { variant: "neutral", label: "Scheduled" },
  IN_PROGRESS: { variant: "info", label: "In Progress" },
  COMPLETED: { variant: "success", label: "Completed" },
  SKIPPED: { variant: "neutral", label: "Skipped" },
  // Finance / invoice
  SENT: { variant: "warning", label: "Sent" },
  PAID: { variant: "success", label: "Paid" },
  VOID: { variant: "neutral", label: "Void" },
  OVERDUE: { variant: "danger", label: "Overdue" },
  VIEWED: { variant: "info", label: "Viewed" },
  PARTIAL: { variant: "warning", label: "Partial" },
  PROCESSING: { variant: "info", label: "Processing" },
  FAILED: { variant: "danger", label: "Failed" },
  // Returns / credit notes
  RETURNED: { variant: "warning", label: "Returned" },
  REFUNDED: { variant: "success", label: "Refunded" },
  RECEIVED: { variant: "success", label: "Received" },
  APPROVED: { variant: "success", label: "Approved" },
  REJECTED: { variant: "danger", label: "Rejected" },
  // Estimates
  EXPIRED: { variant: "danger", label: "Expired" },
  ACCEPTED: { variant: "success", label: "Accepted" },
  DECLINED: { variant: "danger", label: "Declined" },
  // Payments
  ADVANCE: { variant: "info", label: "Advance" },
  CREDIT_NOTE: { variant: "neutral", label: "Credit Note" },
  // Credit notes
  ISSUED: { variant: "success", label: "Issued" },
  APPLIED: { variant: "success", label: "Applied" },
  // Estimates
  CONVERTED: { variant: "success", label: "Converted" },
  // Returns / logistics
  IN_TRANSIT: { variant: "info", label: "In Transit" },
  WRITTEN_OFF: { variant: "neutral", label: "Written Off" },
  PROCESSED: { variant: "success", label: "Processed" },
};

/**
 * Foreground and tint per tone, as hex, for platforms without Tailwind. They are the values web
 * `Badge` renders: `text-[#15803D]` on `bg-success-bg`, etc., and ink-500 on sunken for neutral.
 */
export const TONE_COLORS: Record<BadgeVariant, { fg: string; bg: string }> = {
  // The four inks are literal in web `Badge` (darker than the Ledger status fg, for contrast).
  success: { fg: "#15803D", bg: ledgerStatus.success.bg },
  warning: { fg: "#B45309", bg: ledgerStatus.warning.bg },
  danger: { fg: "#B91C1C", bg: ledgerStatus.danger.bg },
  info: { fg: "#0369A1", bg: ledgerStatus.info.bg },
  neutral: { fg: ledgerInk[500], bg: ledgerSurface.sunken },
};

/**
 * Resolve a badge's tone and label the way web `Badge` does: an explicit variant wins over the
 * status's tone, and an explicit label wins over the status's label, then the raw status.
 */
export function resolveStatusTone(opts: {
  status?: BadgeStatus;
  variant?: BadgeVariant;
  label?: string;
}): StatusToneEntry {
  const entry = opts.status ? STATUS_TONES[opts.status] : undefined;
  return {
    variant: opts.variant ?? entry?.variant ?? "neutral",
    label: opts.label ?? entry?.label ?? opts.status ?? "",
  };
}
