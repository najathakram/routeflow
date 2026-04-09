"use client";

import * as React from "react";

interface AdminCardProps {
  title?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  noPadding?: boolean;
}

export function AdminCard({ title, actions, children, className = "", noPadding }: AdminCardProps) {
  return (
    <div className={`rounded-xl bg-slate-800 ring-1 ring-white/5 ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between border-b border-slate-700 px-5 py-4">
          {title && <h2 className="text-sm font-semibold text-white">{title}</h2>}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={noPadding ? "" : "p-5"}>{children}</div>
    </div>
  );
}
