"use client";

import * as React from "react";
import { cn } from "./utils";

export interface Tab {
  key: string;
  label: string;
  badge?: number;
}

export interface TabsProps {
  tabs: Tab[];
  activeKey: string;
  onChange: (key: string) => void;
  className?: string;
}

export function Tabs({ tabs, activeKey, onChange, className }: TabsProps) {
  return (
    <div className={cn("flex gap-0 border-b border-surface-border", className)}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          onClick={() => onChange(tab.key)}
          className={cn(
            "relative flex items-center gap-1.5 px-3 pb-3 pt-2 text-sm font-medium transition-colors",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500",
            activeKey === tab.key
              ? "text-navy after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:rounded-t after:bg-brand-500"
              : "text-navy/60 hover:text-navy/80",
          )}
        >
          {tab.label}
          {tab.badge !== undefined && tab.badge > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-100 px-1 text-[10px] font-semibold text-brand-700">
              {tab.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
