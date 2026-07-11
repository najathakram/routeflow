"use client";

import * as React from "react";
import { cn } from "@routeflow/ui/web";
import { useProductCategories } from "@/lib/api/products";

interface CategoryComboboxProps {
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  placeholder?: string;
  className?: string;
  id?: string;
}

/**
 * Pick-or-type-new combobox for the free-text product category (UnitCombobox
 * pattern). Suggestions come from GET /products/categories — the tenant's
 * existing categories — and typing anything not in the list simply keeps the
 * text, which becomes a new category on save.
 */
export function CategoryCombobox({
  value,
  onChange,
  required,
  placeholder = "e.g. Bakery, Drinks",
  className,
  id,
}: CategoryComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const { data: categories = [] } = useProductCategories();

  const filtered = value.trim()
    ? categories.filter((c) => c.toLowerCase().includes(value.toLowerCase()))
    : categories;

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
        id={id}
        required={required}
        type="text"
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
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
            filtered.map((c) => (
              <li key={c}>
                <button
                  type="button"
                  onMouseDown={() => {
                    onChange(c);
                    setOpen(false);
                  }}
                  className={cn(
                    "w-full px-3 py-1.5 text-left text-sm text-navy hover:bg-surface-raised transition-colors",
                    value === c && "bg-brand-500/10 font-medium text-brand-600",
                  )}
                >
                  {c}
                </button>
              </li>
            ))
          ) : (
            <li className="px-3 py-1.5 text-xs text-navy/70">
              {value.trim()
                ? "New category — press Enter or click elsewhere to confirm"
                : "No categories yet — type to create one"}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
