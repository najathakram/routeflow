"use client";

import * as React from "react";

/** CQ-11: the customer search came back empty (a typed search with no match), instead of a blank dropdown. */
export const COUNTER_NO_CUSTOMERS_COPY = "No customers found";

/** The slice of a customer row the picker shows and hands back (the screen keeps the whole row). */
export interface CustomerMatch {
  id: string;
  businessName: string;
}

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
}: {
  /** the text in the search field */
  search: string;
  matches: readonly C[];
  /** the search for `search` has an answer (not loading, not failed) */
  answered: boolean;
  disabled: boolean;
  onPick: (customer: C) => void;
}) {
  if (matches.length > 0) {
    return (
      <ul className="rounded border text-sm">
        {matches.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              className="min-h-[44px] w-full px-3 py-2 text-left hover:bg-gray-50"
              disabled={disabled}
              onClick={() => onPick(c)}
            >
              {c.businessName}
            </button>
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
