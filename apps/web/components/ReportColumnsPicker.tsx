"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Button, cn } from "@routeflow/ui/web";

export interface ReportColumnsPickerColumn {
  key: string;
  label: string;
  default: boolean;
}

export interface ReportColumnsPickerProps {
  /** The resolved template's full column superset, in canonical order. */
  columns: ReportColumnsPickerColumn[];
  /** null = template default (nothing customized yet). */
  value: string[] | null;
  onChange: (next: string[] | null) => void;
  onSave?: () => void;
  saving?: boolean;
  disabled?: boolean;
}

const triggerCls =
  "inline-flex items-center gap-1.5 rounded border border-surface-border bg-white px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:cursor-not-allowed disabled:bg-surface-raised disabled:text-navy/50";

/**
 * Column-layout picker for a report template. `value === null` means "use the
 * template's default layout" — nothing customized yet. The seamlessness
 * requirement lives entirely in `toggle`: the FIRST toggle from `null`
 * materializes the template defaults and then applies the single add/remove,
 * so every other column keeps its state and nothing resets underneath the
 * operator. Outside-click/Escape mechanics mirror `DateRangePicker`.
 */
export function ReportColumnsPicker({
  columns,
  value,
  onChange,
  onSave,
  saving,
  disabled,
}: ReportColumnsPickerProps) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  const defaultKeys = React.useMemo(
    () => columns.filter((c) => c.default).map((c) => c.key),
    [columns],
  );
  const checked = value ?? defaultKeys;
  const checkedSet = new Set(checked);

  // Close on outside click or Escape; return focus to the trigger on close.
  React.useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const toggle = (key: string) => {
    const base = value ?? columns.filter((c) => c.default).map((c) => c.key);
    const next = base.includes(key) ? base.filter((k) => k !== key) : [...base, key];
    // Keep canonical order so the emitted list is stable and comparable.
    const ordered = columns.map((c) => c.key).filter((k) => next.includes(k));
    onChange(ordered);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={triggerCls}
      >
        Columns ({checked.length})
        <ChevronDown className="h-3.5 w-3.5" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border border-surface-border bg-white py-2 shadow-dropdown">
          <ul className="max-h-72 overflow-y-auto px-1">
            {columns.map((col) => {
              const isChecked = checkedSet.has(col.key);
              const isLastChecked = isChecked && checked.length === 1;
              return (
                <li key={col.key}>
                  <label
                    className={cn(
                      "flex items-center gap-2 rounded px-2 py-1.5 text-sm text-navy hover:bg-surface-raised",
                      isLastChecked && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      disabled={isLastChecked}
                      onChange={() => toggle(col.key)}
                      className="h-4 w-4 rounded border-surface-border accent-brand-500"
                    />
                    <span className="flex-1">{col.label}</span>
                    {!col.default && (
                      <span className="rounded bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-navy/50">
                        Optional
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="mt-1 flex items-center justify-between gap-2 border-t border-surface-border px-2 pt-2">
            <button
              type="button"
              onClick={() => onChange(null)}
              className="text-xs font-medium text-navy/60 hover:text-navy hover:underline"
            >
              Reset to template
            </button>
            {onSave && (
              <Button variant="secondary" size="sm" loading={saving} onClick={onSave}>
                Save for this section
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
