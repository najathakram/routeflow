"use client";

import * as React from "react";

export interface Tab {
  key: string;
  label: string;
  icon?: React.ReactNode;
}

interface AdminTabsProps {
  tabs: Tab[];
  active: string;
  onChange: (key: string) => void;
}

export function AdminTabs({ tabs, active, onChange }: AdminTabsProps) {
  return (
    // B559: a plain `flex` row of 5 tabs has no room at 390px — with no wrap and the browser's
    // default `min-width: auto` on each flex-item button, the row refuses to shrink below its
    // combined min-content width (~621px measured) and blows out `(platform-admin)/layout.tsx`'s
    // `<main className="flex-1 overflow-y-auto">` shell, which silently becomes a second
    // horizontal scroll container (overflow-y:auto forces overflow-x:auto too) — invisible at
    // rest, then snapped into view (clipping the left edge) the moment a tab click's native
    // focus-scroll drags it into frame. House pattern for a tab strip that must fit small
    // viewports: scroll the strip itself (`overflow-x-auto`) with `shrink-0 whitespace-nowrap` on
    // each trigger, same as `customers/[id]/page.tsx`'s `Tabs.List`/`TabTrigger` — never let the
    // row's own overflow escape into an ancestor.
    <div className="flex gap-1 overflow-x-auto border-b border-slate-700 mb-6">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onChange(tab.key)}
          className={`flex shrink-0 items-center gap-2 whitespace-nowrap px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
            active === tab.key
              ? "border-indigo-500 text-white"
              : "border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600"
          }`}
        >
          {tab.icon}
          {tab.label}
        </button>
      ))}
    </div>
  );
}
