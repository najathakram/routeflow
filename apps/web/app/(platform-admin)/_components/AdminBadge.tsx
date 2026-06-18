"use client";

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: "bg-green-900/40 text-green-400 ring-green-600/30",
  TRIAL: "bg-yellow-900/40 text-yellow-400 ring-yellow-600/30",
  SUSPENDED: "bg-red-900/40 text-red-400 ring-red-600/30",
  CANCELLED: "bg-slate-700 text-slate-400 ring-slate-600/30",
};

const PLAN_COLORS: Record<string, string> = {
  STARTER: "bg-slate-700 text-slate-300 ring-slate-600/30",
  PROFESSIONAL: "bg-blue-900/40 text-blue-400 ring-blue-600/30",
  ENTERPRISE: "bg-purple-900/40 text-purple-400 ring-purple-600/30",
};

interface AdminBadgeProps {
  children: string;
  variant?: "status" | "plan";
  className?: string;
}

export function AdminBadge({ children, variant = "status", className = "" }: AdminBadgeProps) {
  const colors = variant === "plan" ? PLAN_COLORS : STATUS_COLORS;
  const colorClass = colors[children] ?? "bg-slate-700 text-slate-400 ring-slate-600/30";
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${colorClass} ${className}`}
    >
      {children}
    </span>
  );
}
