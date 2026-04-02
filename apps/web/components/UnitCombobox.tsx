"use client";

import * as React from "react";
import { cn } from "@routeflow/ui/web";

export const COMMON_UNITS = [
  "each", "unit", "pcs", "case", "box", "bag", "pack", "dozen", "bundle", "tray", "pallet",
  "kg", "g", "lb", "oz",
  "L", "ml", "liter",
  "roll", "sheet", "bottle", "can", "strip",
];

interface UnitComboboxProps {
  value: string;
  onChange: (value: string) => void;
  /** Additional units from the existing catalog to suggest */
  extraUnits?: string[];
  required?: boolean;
  placeholder?: string;
  className?: string;
  id?: string;
}

export function UnitCombobox({
  value,
  onChange,
  extraUnits = [],
  required,
  placeholder = "e.g. case, kg, unit",
  className,
  id,
}: UnitComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const allUnits = React.useMemo(
    () => Array.from(new Set([...COMMON_UNITS, ...extraUnits])).sort(),
    [extraUnits],
  );

  const filtered = value.trim()
    ? allUnits.filter((u) => u.toLowerCase().includes(value.toLowerCase()))
    : allUnits;

  // Close on outside click
  React.useEffect(() => {
    function handle(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={inputRef}
        id={id}
        required={required}
        type="text"
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          if (e.key === "Enter" && open) {
            // If exactly one match, select it; otherwise keep typed value
            if (filtered.length === 1) {
              onChange(filtered[0]);
              setOpen(false);
              e.preventDefault();
            } else {
              setOpen(false);
            }
          }
        }}
        className={cn(
          "w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500",
          className,
        )}
      />
      {open && (
        <ul className="absolute left-0 top-full z-50 mt-0.5 max-h-48 w-full overflow-y-auto rounded-lg border border-surface-border bg-white py-1 shadow-dropdown">
          {filtered.length > 0 ? (
            filtered.map((u) => (
              <li key={u}>
                <button
                  type="button"
                  onMouseDown={() => { onChange(u); setOpen(false); }}
                  className={cn(
                    "w-full px-3 py-1.5 text-left text-sm text-navy hover:bg-surface-raised transition-colors",
                    value === u && "bg-brand-500/10 font-medium text-brand-600",
                  )}
                >
                  {u}
                </button>
              </li>
            ))
          ) : (
            <li className="px-3 py-1.5 text-xs text-navy/40">
              New unit type — press Enter or click elsewhere to confirm
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
