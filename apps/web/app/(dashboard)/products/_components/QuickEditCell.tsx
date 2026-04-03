"use client";

import * as React from "react";
import { Plus, Check, X } from "lucide-react";
import { cn } from "@routeflow/ui/web";

export interface EditRecord {
  productId: string;
  productName: string;
  field: string;
  oldValue: string | number | null;
  newValue: string | number | null;
}

interface QuickEditCellProps {
  productId: string;
  productName: string;
  field: string;
  value: string | number | null | undefined;
  placeholder?: string;
  type?: "text" | "number";
  /** When true every cell is clickable to edit */
  quickEditMode: boolean;
  /** When provided, shows a filterable scrollable dropdown of suggestions */
  options?: string[];
  /** Ref of the input in the NEXT row (provided by the parent list) */
  nextInputRef?: React.RefObject<HTMLInputElement | null>;
  onSave: (newVal: string, record: EditRecord) => Promise<void>;
}

export const QuickEditCell = React.forwardRef<HTMLInputElement, QuickEditCellProps>(
  function QuickEditCell(
    {
      productId,
      productName,
      field,
      value,
      placeholder = "Type and press Enter",
      type = "text",
      quickEditMode,
      options,
      nextInputRef,
      onSave,
    },
    ref,
  ) {
    const [editing, setEditing] = React.useState(false);
    const [draft, setDraft] = React.useState("");
    const [saving, setSaving] = React.useState(false);
    const [highlightedIndex, setHighlightedIndex] = React.useState(-1);
    const inputRef = React.useRef<HTMLInputElement>(null);
    const dropdownRef = React.useRef<HTMLUListElement>(null);

    // Expose the input ref so the parent can focus it for scanner flow
    React.useImperativeHandle(ref, () => inputRef.current!);

    const isEmpty = value == null || value === "";

    // Filtered options based on current draft
    const filteredOptions = React.useMemo(() => {
      if (!options?.length) return [];
      const q = draft.trim().toLowerCase();
      if (!q) return options;
      return options.filter((o) => o.toLowerCase().includes(q));
    }, [options, draft]);

    const showDropdown = editing && options !== undefined && filteredOptions.length > 0;

    const startEdit = () => {
      setDraft(value != null ? String(value) : "");
      setHighlightedIndex(-1);
      setEditing(true);
    };

    React.useEffect(() => {
      if (editing) {
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }, [editing]);

    // Reset highlight when filtered list changes
    React.useEffect(() => {
      setHighlightedIndex(-1);
    }, [filteredOptions.length]);

    const commit = async (overrideDraft?: string) => {
      if (saving) return;
      const trimmed = (overrideDraft ?? draft).trim();
      const oldValue = value != null ? String(value) : null;
      if (trimmed === oldValue || (trimmed === "" && oldValue === null)) {
        setEditing(false);
        return;
      }
      setSaving(true);
      try {
        await onSave(trimmed, {
          productId,
          productName,
          field,
          oldValue,
          newValue: trimmed || null,
        });
        setEditing(false);
        // Jump focus to next row
        if (nextInputRef?.current) {
          nextInputRef.current.focus();
          nextInputRef.current.select();
        }
      } finally {
        setSaving(false);
      }
    };

    const selectOption = (option: string) => {
      // Commit immediately with the chosen option
      commit(option);
    };

    const cancel = () => {
      setEditing(false);
      setDraft("");
      setHighlightedIndex(-1);
    };

    // In normal mode, always render plain text — no editing affordances
    if (!quickEditMode) {
      return (
        <span className="text-xs text-navy">
          {value != null && value !== "" ? String(value) : "—"}
        </span>
      );
    }

    if (editing) {
      return (
        <div className="relative flex items-center gap-1">
          <div className="relative">
            <input
              ref={inputRef}
              type={type}
              value={draft}
              onChange={(e) => { setDraft(e.target.value); setHighlightedIndex(-1); }}
              onKeyDown={(e) => {
                if (showDropdown) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setHighlightedIndex((i) => Math.min(i + 1, filteredOptions.length - 1));
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setHighlightedIndex((i) => Math.max(i - 1, -1));
                    return;
                  }
                  if (e.key === "Enter" && highlightedIndex >= 0) {
                    e.preventDefault();
                    selectOption(filteredOptions[highlightedIndex]);
                    return;
                  }
                }
                if (e.key === "Enter") { e.preventDefault(); commit(); }
                if (e.key === "Escape") { e.preventDefault(); cancel(); }
              }}
              onBlur={() => {
                // Delay so clicking a dropdown item or the check button doesn't double-fire
                setTimeout(() => { if (editing) commit(); }, 150);
              }}
              placeholder={placeholder}
              disabled={saving}
              className={cn(
                "h-7 w-32 rounded border px-2 text-xs text-navy focus:outline-none focus:ring-1 focus:ring-brand-500",
                saving ? "border-brand-300 bg-brand-50" : "border-brand-400 bg-white",
              )}
            />

            {/* Options dropdown */}
            {showDropdown && (
              <ul
                ref={dropdownRef}
                className="absolute left-0 top-full z-50 mt-0.5 max-h-48 w-40 overflow-y-auto rounded-md border border-surface-border bg-white py-1 shadow-dropdown text-xs"
                onMouseDown={(e) => e.preventDefault()} // prevent blur before click
              >
                {filteredOptions.map((option, idx) => (
                  <li
                    key={option}
                    onClick={() => selectOption(option)}
                    className={cn(
                      "cursor-pointer px-3 py-1.5 text-navy hover:bg-brand-50",
                      idx === highlightedIndex && "bg-brand-50 text-brand-700",
                    )}
                  >
                    {option}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => commit()}
            disabled={saving}
            className="rounded p-0.5 text-success hover:bg-success/10 transition-colors"
            title="Save (Enter)"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={cancel}
            className="rounded p-0.5 text-navy/40 hover:bg-surface-raised transition-colors"
            title="Cancel (Escape)"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      );
    }

    // Quick edit mode — idle state
    if (isEmpty) {
      return (
        <button
          type="button"
          onClick={startEdit}
          className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-navy/20 px-2 py-0.5 text-[11px] text-navy/40 hover:border-brand-400 hover:text-brand-600 transition-colors"
          title={`Add ${field}`}
        >
          <Plus className="h-3 w-3" />
          Add
        </button>
      );
    }

    return (
      <button
        type="button"
        onClick={startEdit}
        className="group rounded px-1 py-0.5 text-left text-xs text-navy transition-colors hover:bg-brand-50 hover:ring-1 hover:ring-brand-300"
        title={`Click to edit ${field}`}
      >
        {String(value)}
        <span className="ml-1 hidden text-brand-400 group-hover:inline">✎</span>
      </button>
    );
  },
);
