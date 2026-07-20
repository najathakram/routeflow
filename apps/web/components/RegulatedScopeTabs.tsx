"use client";

import * as React from "react";
import { Tabs, cn } from "@routeflow/ui/web";

interface RegulatedScopeTabsProps {
  /** Current ?section= value: "" | "any" | "none" | <sectionId>. */
  value: string;
  onChange: (next: string) => void;
  /** ACTIVE sections (chips + badge). Component renders null when empty. */
  sections: Array<{ id: string; name: string; productCount?: number }>;
  className?: string;
}

/**
 * Shared scope control replacing the old Section `<select>` on Products +
 * Inventory's Stock tab: All | Regulated (badge) | Non-regulated tabs, with a
 * per-section chip row when Regulated is active. Maps 1:1 onto the existing
 * `?section=` contract (`"" | "any" | "none" | <uuid>`) so deep links (e.g.
 * the Compliance KPI link `?section=<id>`) keep working.
 */
export function RegulatedScopeTabs({
  value,
  onChange,
  sections,
  className,
}: RegulatedScopeTabsProps) {
  if (sections.length === 0) return null;

  const scope = value === "" ? "all" : value === "none" ? "none" : "regulated";

  const regulatedBadge = sections.reduce((sum, s) => sum + (s.productCount ?? 0), 0);

  return (
    <div
      className={cn(
        scope !== "all" && "rounded-lg border border-brand-200 bg-brand-50/40 px-3 pt-1 pb-2",
        className,
      )}
    >
      <Tabs
        tabs={[
          { key: "all", label: "All products" },
          {
            key: "regulated",
            label: "Regulated",
            ...(regulatedBadge > 0 ? { badge: regulatedBadge } : {}),
          },
          { key: "none", label: "Non-regulated" },
        ]}
        activeKey={scope}
        onChange={(key) => {
          if (key === "all") onChange("");
          else if (key === "regulated") onChange("any");
          else onChange("none");
        }}
      />

      {scope === "regulated" && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onChange("any")}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium whitespace-nowrap transition-colors",
              value === "any"
                ? "border-navy bg-navy text-white"
                : "border-surface-border bg-white text-navy hover:bg-surface-raised",
            )}
          >
            All sections
          </button>
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onChange(s.id)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium whitespace-nowrap transition-colors",
                value === s.id
                  ? "border-navy bg-navy text-white"
                  : "border-surface-border bg-white text-navy hover:bg-surface-raised",
              )}
            >
              {s.name}
              {!!s.productCount && s.productCount > 0 && (
                <span className="text-[10px] opacity-70">{s.productCount}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
