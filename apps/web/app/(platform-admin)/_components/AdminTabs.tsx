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
    <div className="flex gap-1 border-b border-slate-700 mb-6">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onChange(tab.key)}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
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
