"use client";

import type {
  BuyerAccountStatusValue,
  CustomerLinkStatusValue,
  TenantPlanValue,
  TenantStatusValue,
  UserStatusValue,
} from "@routeflow/types";

const SLATE = "bg-slate-700 text-slate-300 ring-slate-600/30";
const GREEN = "bg-green-900/40 text-green-400 ring-green-600/30";
const YELLOW = "bg-yellow-900/40 text-yellow-400 ring-yellow-600/30";
const AMBER = "bg-amber-900/40 text-amber-400 ring-amber-600/30";
const RED = "bg-red-900/40 text-red-400 ring-red-600/30";
const BLUE = "bg-blue-900/40 text-blue-400 ring-blue-600/30";
const TEAL = "bg-teal-900/40 text-teal-400 ring-teal-600/30";

// Every value of the five server enums the badge renders (tenant, user, buyer account, customer link),
// so a new enum value is a compile error here, not a silent slate badge (SA-1049 R5).
type BadgeStatus =
  TenantStatusValue | UserStatusValue | BuyerAccountStatusValue | CustomerLinkStatusValue;

const STATUS_COLORS: Record<BadgeStatus, string> = {
  ACTIVE: GREEN,
  TRIAL: YELLOW,
  PENDING_SELLER_APPROVAL: YELLOW,
  READ_ONLY: AMBER,
  SUSPENDED: RED,
  INVITED: BLUE,
  CANCELLED: SLATE,
  INACTIVE: SLATE,
  DELETED: SLATE,
  DISCONNECTED: SLATE,
};

const PLAN_COLORS: Record<TenantPlanValue, string> = {
  LITE: SLATE,
  STARTER: SLATE,
  TEAM: TEAL,
  GROWTH: TEAL,
  BUSINESS: BLUE,
  PROFESSIONAL: BLUE,
  SCALE: "bg-indigo-900/40 text-indigo-400 ring-indigo-600/30",
  ENTERPRISE: "bg-purple-900/40 text-purple-400 ring-purple-600/30",
};

// Display labels — the plan enum's middle tier is branded "Business" in the
// designs (dashboard donut, plans editor). Enum values stay unchanged.
const PLAN_LABELS: Record<TenantPlanValue, string> = {
  LITE: "Lite",
  STARTER: "Starter",
  TEAM: "Team",
  BUSINESS: "Business",
  PROFESSIONAL: "Business",
  GROWTH: "Growth",
  SCALE: "Scale",
  ENTERPRISE: "Enterprise",
};

// Display labels for status enums (tenant, buyer account, customer link, user).
// Enum values stay unchanged; STATUS_COLORS is still keyed on the raw value.
const STATUS_LABELS: Record<BadgeStatus, string> = {
  TRIAL: "Trial",
  ACTIVE: "Active",
  READ_ONLY: "Read-only",
  SUSPENDED: "Suspended",
  CANCELLED: "Cancelled",
  DELETED: "Deleted",
  INACTIVE: "Inactive",
  INVITED: "Invited",
  PENDING_SELLER_APPROVAL: "Pending seller approval",
  DISCONNECTED: "Disconnected",
};

/** Friendly display name for a status enum value (sentence-case fallback). */
export function statusLabel(s: string): string {
  return (
    (STATUS_LABELS as Record<string, string | undefined>)[s] ??
    (s.charAt(0) + s.slice(1).toLowerCase()).replace(/_/g, " ")
  );
}

/** Friendly display name for a plan enum value (falls back to the raw value). */
export function planLabel(plan: string): string {
  return (PLAN_LABELS as Record<string, string | undefined>)[plan] ?? plan;
}

interface AdminBadgeProps {
  children: string;
  variant?: "status" | "plan";
  className?: string;
}

export function AdminBadge({ children, variant = "status", className = "" }: AdminBadgeProps) {
  const colors: Record<string, string | undefined> =
    variant === "plan" ? PLAN_COLORS : STATUS_COLORS;
  const colorClass = colors[children] ?? SLATE;
  const text = variant === "plan" ? planLabel(children) : statusLabel(children);
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${colorClass} ${className}`}
    >
      {text}
    </span>
  );
}
