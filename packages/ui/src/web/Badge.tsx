import * as React from "react";
import { cn } from "./utils";

export type BadgeVariant = "success" | "warning" | "danger" | "info" | "neutral";

export type BadgeStatus =
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
  | "COMPLETED";

const STATUS_MAP: Record<BadgeStatus, { variant: BadgeVariant; label: string }> = {
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
