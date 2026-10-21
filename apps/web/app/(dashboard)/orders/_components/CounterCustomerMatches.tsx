"use client";

import * as React from "react";
import { cn } from "@routeflow/ui/web";

/** CQ-11: the customer search came back empty (a typed search with no match), instead of a blank dropdown. */
export const COUNTER_NO_CUSTOMERS_COPY = "No customers found";

/** The slice of a customer row the picker shows and hands back (the screen keeps the whole row). */
export interface CustomerMatch {
  id: string;
  businessName: string;
}

/**
 * R7b 1.2 (c): the WAI-ARIA combobox/listbox pattern for the search field. The field keeps DOM focus; ArrowDown/ArrowUp move
 * `aria-activedescendant` over the matches, Enter picks the active one (with none active, Enter is left to the field), and
 * Escape closes the list until the search text changes. Spread `inputProps` on the field and pass `listboxProps` to the list.
 */
export function useCustomerListbox<C extends CustomerMatch>(
  matches: readonly C[],
  search: string,
  onPick: (customer: C) => void,
) {
  const baseId = React.useId();
  const [active, setActive] = React.useState(-1);
  const [closed, setClosed] = React.useState(false);
  // a new search (or a new answer) starts over
  const matchKey = matches.map((c) => c.id).join("|");
  React.useEffect(() => {
    setActive(-1);
    setClosed(false);
  }, [search, matchKey]);
  const open = matches.length > 0 && !closed;
  const optionId = (i: number) => `${baseId}-opt-${i}`;
  const inputProps = {
    role: "combobox" as const,
    "aria-autocomplete": "list" as const,
    "aria-expanded": open,
    "aria-controls": open ? `${baseId}-list` : undefined,
    "aria-activedescendant": open && active >= 0 ? optionId(active) : undefined,
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (matches.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setClosed(false);
        setActive((i) => (i + 1) % matches.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setClosed(false);
        setActive((i) => (i <= 0 ? matches.length - 1 : i - 1));
      } else if (e.key === "Enter" && open && active >= 0 && matches[active]) {
        e.preventDefault();
        onPick(matches[active]);
      } else if (e.key === "Escape" && open) {
        e.preventDefault();
        setClosed(true);
        setActive(-1);
      }
    },
  };
  return {
    inputProps,
    listbox: { id: `${baseId}-list`, open, active, optionId },
  };
}

export type CustomerListbox = ReturnType<typeof useCustomerListbox>["listbox"];

/**
 * The counter's customer search results: up to six names to pick from, or, once a typed search has answered with nothing, a
 * plain "No customers found" (CQ-11) instead of an empty dropdown. Nothing shows before the first answer or for a blank search.
 */
export function CounterCustomerMatches<C extends CustomerMatch>({
  search,
  matches,
  answered,
  disabled,
  onPick,
  listbox,
}: {
  /** the text in the search field */
  search: string;
  matches: readonly C[];
  /** the search for `search` has an answer (not loading, not failed) */
  answered: boolean;
  disabled: boolean;
  onPick: (customer: C) => void;
  /** keyboard state from `useCustomerListbox`; without it the list is click-only */
  listbox?: CustomerListbox;
}) {
  if (matches.length > 0) {
    if (listbox && !listbox.open) return null;
    return (
      <ul
        className="rounded border text-sm"
        role={listbox ? "listbox" : undefined}
        id={listbox?.id}
        aria-label={listbox ? "Matching customers" : undefined}
      >
        {matches.map((c, i) => (
          <li
            key={c.id}
            role={listbox ? "option" : undefined}
            id={listbox?.optionId(i)}
            aria-selected={listbox ? listbox.active === i : undefined}
            aria-disabled={disabled || undefined}
            className={cn(
              "min-h-[44px] w-full px-3 py-2 text-left",
              disabled ? "opacity-40" : "cursor-pointer hover:bg-gray-50",
              listbox?.active === i && "bg-gray-100",
            )}
            onClick={() => {
              if (!disabled) onPick(c);
            }}
          >
            {c.businessName}
          </li>
        ))}
      </ul>
    );
  }
  if (search.trim() && answered) {
    return (
      <p role="status" className="text-sm text-navy/70" data-testid="counter-customer-none">
        {COUNTER_NO_CUSTOMERS_COPY}
      </p>
    );
  }
  return null;
}
