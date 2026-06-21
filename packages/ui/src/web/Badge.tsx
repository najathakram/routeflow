import * as React from "react";
import { cn } from "./utils";

export type BadgeVariant = "success" | "warning" | "danger" | "info" | "neutral";

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

const STATUS_MAP: Record<BadgeStatus, { variant: BadgeVariant; label: string }> = {
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

const VARIANT_STYLES: Record<BadgeVariant, { badge: string; dot: string }> = {
  success: {
    badge: "bg-success-bg text-success",
    dot: "bg-success",
  },
  warning: {
    badge: "bg-warning-bg text-warning",
    dot: "bg-warning",
  },
  danger: {
    badge: "bg-danger-bg text-danger",
    dot: "bg-danger",
  },
  info: {
    badge: "bg-brand-100 text-brand-700",
    dot: "bg-brand-500",
  },
  neutral: {
    badge: "bg-surface-raised text-navy/70 border border-surface-border",
    dot: "bg-navy/40",
  },
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  status?: BadgeStatus;
  label?: string;
}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, status, label, ...props }, ref) => {
    const resolved = status ? STATUS_MAP[status] : null;
    const resolvedVariant = variant ?? resolved?.variant ?? "neutral";
    const resolvedLabel = label ?? resolved?.label ?? status ?? "";

    const styles = VARIANT_STYLES[resolvedVariant];

    return (
      <span
        ref={ref}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
          styles.badge,
          className,
        )}
        {...props}
      >
        <span className={cn("h-1.5 w-1.5 rounded-full flex-shrink-0", styles.dot)} />
        {resolvedLabel}
      </span>
    );
  },
);

Badge.displayName = "Badge";
