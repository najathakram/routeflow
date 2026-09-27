/**
 * The ONE status → tone map (#2332, plan §2.3 / §5 R2), consumed by both web `Badge`
 * (`./web/Badge.tsx`) and native `Badge` (`./native/Badge.tsx`). Before this, each side kept its
 * own map. Plain data only: no platform code.
 */
import { ledgerInk, ledgerStatus, ledgerSurface } from "./tokens/ledger";

/** The five badge tones (web `BadgeVariant`). */
export type BadgeVariant = "success" | "warning" | "danger" | "info" | "neutral";

export interface StatusToneEntry {
  variant: BadgeVariant;
  label: string;
}

export type BadgeStatus =
  | "DRAFT"
  | "ACTIVE"
  | "INACTIVE"
  | "SUSPENDED"
  | "PENDING"
  | "CONFIRMED"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "CANCELLED"
  | "SCHEDULED"
  | "IN_PROGRESS"
  | "COMPLETED"
  // Finance / invoice statuses
  | "SENT"
  | "PAID"
  | "VOID"
  | "OVERDUE"
  | "VIEWED"
  | "PARTIAL"
  | "PROCESSING"
  | "FAILED"
  // Returns / credit notes
  | "RETURNED"
  | "REFUNDED"
  | "RECEIVED"
  | "APPROVED"
  | "REJECTED"
  // Estimates
  | "EXPIRED"
  | "ACCEPTED"
  | "DECLINED"
  // Payments
  | "ADVANCE"
  | "CREDIT_NOTE"
  // Credit notes
  | "ISSUED"
  | "APPLIED"
  // Estimates
  | "CONVERTED"
  // Returns / logistics
  | "IN_TRANSIT"
  | "WRITTEN_OFF"
  | "PROCESSED";

export const STATUS_TONES: Record<BadgeStatus, StatusToneEntry> = {
  DRAFT: { variant: "neutral", label: "Draft" },
  ACTIVE: { variant: "success", label: "Active" },
  INACTIVE: { variant: "neutral", label: "Inactive" },
  SUSPENDED: { variant: "danger", label: "Suspended" },
  PENDING: { variant: "warning", label: "Pending" },
  CONFIRMED: { variant: "info", label: "Confirmed" },
  OUT_FOR_DELIVERY: { variant: "info", label: "Out for Delivery" },
  DELIVERED: { variant: "success", label: "Delivered" },
  CANCELLED: { variant: "danger", label: "Cancelled" },
  SCHEDULED: { variant: "neutral", label: "Scheduled" },
  IN_PROGRESS: { variant: "info", label: "In Progress" },
  COMPLETED: { variant: "success", label: "Completed" },
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
