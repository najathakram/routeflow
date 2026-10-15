"use client";

import * as React from "react";
import { cn } from "@routeflow/ui/web";
import { AnchoredList, isInsideAnchoredList } from "./AnchoredList";
import { COMMON_UNITS } from "@/lib/common-units";

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
  const listId = React.useId();
  const [active, setActive] = React.useState(-1);
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
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node) &&
        !isInsideAnchoredList(e.target)
      ) {
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
        onChange={(e) => {
          onChange(e.target.value);
          setActive(-1);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
            const last = filtered.length - 1;
            setActive((a) => (e.key === "ArrowDown" ? Math.min(a + 1, last) : Math.max(a - 1, 0)));
            return;
          }
          if (e.key === "Escape") setOpen(false);
          if (e.key === "Enter" && open) {
            // A highlighted option wins; if exactly one match, select it; otherwise keep typed value
            const pick =
              active >= 0 ? filtered[active] : filtered.length === 1 ? filtered[0] : null;
            if (pick != null) {
              onChange(pick);
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
      <AnchoredList anchorRef={containerRef} open={open} id={listId}>
        <ul role="listbox" className="py-1">
          {filtered.length > 0 ? (
            filtered.map((u, i) => (
              <li key={u} role="option" id={`${listId}-${i}`} aria-selected={i === active}>
                <button
                  type="button"
                  onMouseDown={() => {
                    onChange(u);
                    setOpen(false);
                  }}
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
            <li className="px-3 py-1.5 text-xs text-navy/70">
              New unit type — press Enter or click elsewhere to confirm
            </li>
          )}
        </ul>
      </AnchoredList>
    </div>
  );
}
