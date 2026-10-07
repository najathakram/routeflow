import * as React from "react";
import { cn } from "@routeflow/ui/web";
import { useListboxNav } from "@/lib/use-listbox-nav";

interface PickerCustomer {
  id: string;
  businessName: string;
  contactName?: string | null;
}

interface Props<C extends PickerCustomer> {
  value: string;
  onValueChange: (v: string) => void;
  results: C[];
  /** The debounced search is non-empty, so "No customers found." is a real answer. */
  searched: boolean;
  /** Escape closes the list but keeps the text (K3). */
  listOpen: boolean;
  onListOpenChange: (open: boolean) => void;
  onPick: (c: C) => void;
  error?: string;
  inputRef: React.Ref<HTMLInputElement>;
}

/**
 * The Create Order customer search: type, ArrowUp/Down to highlight, Enter or click or Space (a
 * focused row) to pick, Escape to close the list. The rows are `button[role=option]` — the form's
 * Enter guard exempts exactly those so Tab-to-row + Enter picks.
 */
export function CustomerSearchPicker<C extends PickerCustomer>({
  value,
  onValueChange,
  results,
  searched,
  listOpen,
  onListOpenChange,
  onPick,
  error,
  inputRef,
}: Props<C>) {
  const show = listOpen && !!value && (results.length > 0 || searched);
  const nav = useListboxNav({
    items: results,
    open: show,
    onPick,
    onClose: () => onListOpenChange(false),
    resetKey: value,
    idPrefix: "customer-search",
  });
  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="search"
        placeholder="Search by business name…"
        aria-label="Search customers"
        value={value}
        onChange={(e) => {
          onValueChange(e.target.value);
          onListOpenChange(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !show && value) onListOpenChange(true);
          nav.onKeyDown(e);
        }}
        {...nav.inputProps}
        className={cn(
          "h-10 w-full rounded border bg-white px-3 text-sm text-navy placeholder:text-navy/70 focus:outline-none focus:ring-2 focus:ring-brand-500",
          error
            ? "border-danger focus:border-transparent"
            : "border-surface-border focus:border-transparent",
        )}
      />
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      {show && (
        <ul
          id={nav.listId}
          role="listbox"
          aria-label="Customers"
          className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-surface-border bg-white shadow-dropdown"
        >
          {results.length === 0 && searched && (
            <li className="px-3 py-2 text-sm text-navy/70">No customers found.</li>
          )}
          {results.map((c, i) => (
            <li key={c.id} role="presentation">
              <button
                type="button"
                role="option"
                id={nav.optionId(i)}
                aria-selected={i === nav.highlight}
                onClick={() => onPick(c)}
                onMouseEnter={() => nav.setHighlight(i)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-navy hover:bg-surface-raised",
                  i === nav.highlight && "bg-surface-raised",
                )}
              >
                <span className="font-medium">{c.businessName}</span>
                {c.contactName && <span className="text-xs text-navy/70">{c.contactName}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
