"use client";

import * as React from "react";
import { X } from "lucide-react";
import { cn, useToast } from "@routeflow/ui/web";
import { useTrackedSubcategories, useCreateSubcategory } from "@/lib/api/tracked-categories";
import { subcategoryPickerOptions } from "@/lib/regulated-format";

interface SubcategoryComboboxProps {
  /** Parent section — null/"" disables the field ("Pick a section first"). */
  sectionId: string | null;
  /** Selected subcategory id ("" = none). */
  value: string;
  /** Fires with the picked/created subcategory id ("" = cleared). */
  onChange: (subcategoryId: string) => void;
  disabled?: boolean;
  /** Compact table-cell sizing (SectionEditCell). */
  compact?: boolean;
  className?: string;
  placeholder?: string;
}

/**
 * ID-based type-ahead for `TrackedSubcategory` — unlike `CategoryCombobox`
 * (whose typed string IS the value), a subcategory is a real row: `value` is
 * an id, and typing an unknown name offers an explicit "+ Create" row that
 * mints one (`POST /tracked-categories/:id/subcategories`) and selects it.
 * Dropdown mechanics mirror `CategoryCombobox` (open state, outside-click
 * `mousedown` close, absolute `z-50` list, option `<button onMouseDown>`).
 *
 * Case-insensitive dup guard: the create row is only offered when no visible
 * option's name already matches the typed text case-insensitively — an
 * existing (or reactivated) match is offered for selection instead of a
 * doomed-to-409 create. The server (`createSubcategory`) enforces the same
 * rule as a backstop for races between two operators.
 */
export function SubcategoryCombobox({
  sectionId,
  value,
  onChange,
  disabled,
  compact,
  className,
  placeholder,
}: SubcategoryComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const containerRef = React.useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const { data: subs = [], refetch: refetchSubs } = useTrackedSubcategories(sectionId || undefined);
  const createSub = useCreateSubcategory();

  // Options include the currently-selected subcategory even if it was since
  // deactivated (labelled inactive) — same drift-proofing as the old selects.
  const options = subcategoryPickerOptions(subs, value);
  const isDisabled = disabled || !sectionId;

  const trimmedQuery = query.trim();
  const lowerQuery = trimmedQuery.toLowerCase();
  const filtered = trimmedQuery
    ? options.filter((o) => o.name.toLowerCase().includes(lowerQuery))
    : options;
  const exactMatch = trimmedQuery
    ? options.find((o) => o.name.toLowerCase() === lowerQuery)
    : undefined;
  const showCreateRow = trimmedQuery.length > 0 && !exactMatch;

  const selected = options.find((o) => o.id === value);
  const displayValue = open ? query : (selected?.name ?? "");

  // Close on outside click.
  React.useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  const selectOption = (id: string) => {
    onChange(id);
    setQuery("");
    setOpen(false);
  };

  const handleCreate = async () => {
    if (!sectionId || !trimmedQuery || createSub.isPending) return;
    try {
      const created = await createSub.mutateAsync({ categoryId: sectionId, name: trimmedQuery });
      onChange(created.id);
      setQuery("");
      setOpen(false);
    } catch (err: any) {
      if (err?.response?.status === 409) {
        // Race: someone minted the same (case-insensitive) name between our
        // pre-guard check and this request. Refetch and select the winner
        // instead of leaving the operator staring at a bare error.
        const { data: freshSubs } = await refetchSubs();
        const match = (freshSubs ?? []).find((s) => s.name.trim().toLowerCase() === lowerQuery);
        if (match) {
          onChange(match.id);
          setQuery("");
          setOpen(false);
          return;
        }
      }
      toast({
        title: err?.response?.data?.message ?? "Failed to create subcategory",
        variant: "error",
      });
    }
  };

  const effectivePlaceholder = !sectionId
    ? "Pick a section first"
    : subs.length === 0
      ? "None — type to create"
      : (placeholder ?? "Select or type a subcategory");

  return (
    <div ref={containerRef} className={cn("relative", compact ? "w-36" : "w-full")}>
      <div className="relative">
        <input
          type="text"
          value={displayValue}
          disabled={isDisabled}
          placeholder={effectivePlaceholder}
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
              setQuery("");
            } else if (e.key === "Enter" && open) {
              e.preventDefault();
              if (filtered.length === 1) {
                selectOption(filtered[0].id);
              } else if (filtered.length === 0 && trimmedQuery) {
                handleCreate();
              }
            }
          }}
          className={cn(
            "w-full rounded border border-surface-border text-navy focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:cursor-not-allowed disabled:bg-surface-raised/60 disabled:text-navy/50",
            compact ? "h-7 px-1.5 pr-6 text-xs" : "px-3 py-2 pr-8 text-sm",
            className,
          )}
        />
        {!isDisabled && value && !open && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange("")}
            title="Clear subcategory"
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-navy/30 transition-colors hover:bg-surface-raised hover:text-navy"
          >
            <X className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
          </button>
        )}
      </div>
      {open && !isDisabled && (
        <ul className="absolute left-0 top-full z-50 mt-0.5 max-h-48 w-full min-w-[10rem] overflow-y-auto rounded-lg border border-surface-border bg-white py-1 shadow-dropdown">
          {filtered.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                onMouseDown={() => selectOption(o.id)}
                className={cn(
                  "w-full px-3 py-1.5 text-left text-sm text-navy hover:bg-surface-raised transition-colors",
                  o.id === value && "bg-brand-500/10 font-medium text-brand-600",
                )}
              >
                {o.name}
                {o.inactive ? " (inactive)" : ""}
              </button>
            </li>
          ))}
          {filtered.length === 0 && !showCreateRow && (
            <li className="px-3 py-1.5 text-xs text-navy/70">No subcategories yet.</li>
          )}
          {showCreateRow && (
            <li>
              <button
                type="button"
                disabled={createSub.isPending}
                onMouseDown={handleCreate}
                className="w-full px-3 py-1.5 text-left text-sm font-medium text-brand-600 transition-colors hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {createSub.isPending ? "Creating…" : `+ Create "${trimmedQuery}"`}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
