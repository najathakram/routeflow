"use client";

import * as React from "react";
import { Download, Printer } from "lucide-react";

interface DatePreset {
  label: string;
  from: string;
  to: string;
}

interface ReportToolbarProps {
  from: string;
  to: string;
  onFromChange: (val: string) => void;
  onToChange: (val: string) => void;
  onExportCSV?: () => void;
  onPrint?: () => void;
  children?: React.ReactNode; // Additional filters
}

function getPresets(): DatePreset[] {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();

  const fmt = (d: Date) => d.toISOString().split("T")[0];

  return [
    { label: "This Month", from: fmt(new Date(y, m, 1)), to: fmt(new Date(y, m + 1, 0)) },
    { label: "Last Month", from: fmt(new Date(y, m - 1, 1)), to: fmt(new Date(y, m, 0)) },
    {
      label: "This Quarter",
      from: fmt(new Date(y, Math.floor(m / 3) * 3, 1)),
      to: fmt(new Date(y, Math.floor(m / 3) * 3 + 3, 0)),
    },
    { label: "This Year", from: fmt(new Date(y, 0, 1)), to: fmt(new Date(y, 11, 31)) },
    { label: "Last Year", from: fmt(new Date(y - 1, 0, 1)), to: fmt(new Date(y - 1, 11, 31)) },
  ];
}

export function ReportToolbar({
  from,
  to,
  onFromChange,
  onToChange,
  onExportCSV,
  onPrint,
  children,
}: ReportToolbarProps) {
  const presets = React.useMemo(() => getPresets(), []);

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-surface-border bg-white p-3">
      {/* Date preset buttons */}
      <div className="flex items-center gap-1">
        {presets.map((p) => (
          <button
            key={p.label}
            onClick={() => {
              onFromChange(p.from);
              onToChange(p.to);
            }}
            className={`rounded px-2.5 py-1.5 text-xs font-medium transition-colors ${
              from === p.from && to === p.to
                ? "bg-brand-500 text-white"
                : "bg-surface-raised text-navy/70 hover:bg-surface-border hover:text-navy"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Date inputs */}
      <div className="flex items-center gap-2">
        <input
          type="date"
          value={from}
          onChange={(e) => onFromChange(e.target.value)}
          className="h-9 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
        <span className="text-sm text-navy/70">to</span>
        <input
          type="date"
          value={to}
          onChange={(e) => onToChange(e.target.value)}
          className="h-9 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
      </div>

      {/* Additional filters passed as children */}
      {children}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Export + Print */}
      {onExportCSV && (
        <button
          onClick={onExportCSV}
          className="flex items-center gap-1.5 rounded border border-surface-border bg-white px-3 py-1.5 text-sm font-medium text-navy/70 hover:bg-surface-raised hover:text-navy transition-colors"
        >
          <Download className="h-4 w-4" />
          Export CSV
        </button>
      )}
      {onPrint && (
        <button
          onClick={onPrint}
          className="flex items-center gap-1.5 rounded border border-surface-border bg-white px-3 py-1.5 text-sm font-medium text-navy/70 hover:bg-surface-raised hover:text-navy transition-colors"
        >
          <Printer className="h-4 w-4" />
          Print
        </button>
      )}
    </div>
  );
}
