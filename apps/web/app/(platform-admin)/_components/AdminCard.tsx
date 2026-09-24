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
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-700 px-5 py-4">
          {title && <h2 className="text-sm font-semibold text-white">{title}</h2>}
          {/* Found on #1288's platform-admin overflow spec: at 390px the
              billing filter row (search + two selects) overflowed 115px with
              no wrap and no scroll affordance. flex-wrap here — a shared
              component used by 6 admin pages — lets any actions row (not
              just billing's) stack onto a second line instead of escaping
              the viewport, strictly safer everywhere this renders. */}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={noPadding ? "" : "p-5"}>{children}</div>
    </div>
  );
}
