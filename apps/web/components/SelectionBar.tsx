"use client";

import * as React from "react";
import { cn } from "@routeflow/ui/web";

const SELECT_ALL_TEXT = "Select all on this page";

/**
 * The bulk-action bar of a list with row selection. From md up it is exactly the page's own bar
 * (`className`, in the page's own place). Below md it is fixed to the bottom of the screen, so
 * ticking a card never inserts anything above the list and moves it; it also holds the "Select all
 * on this page" checkbox there (`selectAll`), which the table shows in its header from md up.
 *
 * The page renders a `SelectionBarSpacer` as the last element of its list section while the bar
 * shows, so everything that follows the list (pagination, footer) can scroll above the bar.
 * Keep every control inside at least 44px tall below md.
 */
export function SelectionBar({
  className,
  selectAll,
  children,
}: {
  /** The page's existing bar classes; they apply unchanged from md up. */
  className: string;
  selectAll?: {
    checked: boolean;
    onChange: () => void;
    indeterminate?: boolean;
    /** Accessible name; defaults to the visible text. */
    label?: string;
  };
  children: React.ReactNode;
}) {
  return (
    <div
      data-selection-bar
      className={cn(
        className,
        "max-md:fixed max-md:inset-x-3 max-md:bottom-[calc(0.75rem+env(safe-area-inset-bottom))] max-md:z-40 max-md:max-h-[60vh] max-md:overflow-y-auto max-md:shadow-card",
      )}
    >
      {selectAll && (
        <label className="flex min-h-[44px] w-full items-center gap-3 text-sm text-navy md:hidden">
          <input
            type="checkbox"
            aria-label={selectAll.label ?? SELECT_ALL_TEXT}
            checked={selectAll.checked}
            ref={(el) => {
              if (el) el.indeterminate = selectAll.indeterminate ?? false;
            }}
            onChange={selectAll.onChange}
            className="h-5 w-5 cursor-pointer rounded border-surface-border text-brand-500 accent-brand-500"
          />
          {SELECT_ALL_TEXT}
        </label>
      )}
      {children}
    </div>
  );
}

/**
 * Empty room at the end of a list section, as tall as the fixed bar, so nothing that follows the
 * list ends up under the bar on a phone. Place it as the LAST element of the list section, after
 * the pagination and any footer, and render it only while the bar renders. `className` is a fixed
 * height class sized to that page's bar (no measuring). It takes no space from md up.
 */
export function SelectionBarSpacer({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" data-selection-bar-spacer className={cn("md:hidden", className)} />
  );
}
