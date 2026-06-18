"use client";

import * as React from "react";

interface AdminStatCardProps {
  label: string;
  value: number | string;
  sub?: string;
  icon?: React.ReactNode;
  trend?: { value: number; label: string };
  className?: string;
}

export function AdminStatCard({
  label,
  value,
  sub,
  icon,
  trend,
  className = "",
}: AdminStatCardProps) {
  return (
    <div className={`rounded-xl bg-slate-800 p-5 ring-1 ring-white/5 ${className}`}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">{label}</p>
          <p className="mt-2 text-3xl font-bold text-white">{value}</p>
          {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
          {trend && (
            <p
              className={`mt-1 text-xs font-medium ${trend.value >= 0 ? "text-green-400" : "text-red-400"}`}
            >
              {trend.value >= 0 ? "+" : ""}
              {trend.value}% {trend.label}
            </p>
          )}
        </div>
        {icon && (
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-700/50 text-slate-400">
            {icon}
          </div>
        )}
      </div>
    </div>
  );
}
