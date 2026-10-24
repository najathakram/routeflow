"use client";

import * as React from "react";
import { cn } from "@routeflow/ui/web";
import { AnchoredList, isInsideAnchoredList } from "./AnchoredList";
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
  const listId = React.useId();
  const [active, setActive] = React.useState(-1);
  const { data: categories = [] } = useProductCategories();

  const filtered = value.trim()
    ? categories.filter((c) => c.toLowerCase().includes(value.toLowerCase()))
    : categories;

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
            filtered.map((c, i) => (
              <li key={c} role="option" id={`${listId}-${i}`} aria-selected={i === active}>
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
      </AnchoredList>
    </div>
  );
}
