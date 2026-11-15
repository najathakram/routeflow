"use client";

import * as React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@routeflow/ui/web";

/**
 * How many filters differ from their defaults. A key missing from `defaults` counts as an empty
 * string, so a page can pass only the defaults that are not "".
 */
export function activeFilterCount(
  values: Record<string, string | null | undefined>,
  defaults: Record<string, string | null | undefined> = {},
): number {
  return Object.keys(values).filter((key) => (values[key] ?? "") !== (defaults[key] ?? "")).length;
}

/**
 * Below md: a "Filters (n)" button that opens the page's existing filter controls in a panel (the
 * same Hide/View chevron toggle with aria-expanded as CustomerAccountStrip). From md up the
 * controls render inline, exactly as before. The children render once, so no control is duplicated.
 *
 * `layout`: "block" (default) makes the root a plain block and the panel `md:block`; use it when
 * the disclosure stands on its own, for example as a child of a `space-y-*` page column (a
 * `display: contents` box would lose that margin) or as its own card. "contents" makes root and
 * panel `md:contents`; use it only for a disclosure placed INSIDE a flex bar whose controls must
 * stay direct flex items of that bar from md up (payments, supplier bills, customers).
 */
export function FiltersDisclosure({
  count,
  children,
  toolbar,
  layout = "block",
}: {
  count: number;
  children: React.ReactNode;
  /** Shown on the same row as the Filters button (below md), outside the panel; for example a sort control. */
  toolbar?: React.ReactNode;
  layout?: "block" | "contents";
}) {
  const contents = layout === "contents";
  const [open, setOpen] = React.useState(false);
  const panelId = React.useId();
  return (
    <div className={cn(contents && "md:contents")}>
      <div className="flex items-center gap-2 md:hidden">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded border border-surface-border bg-white px-3 text-sm font-medium text-navy transition-colors hover:bg-surface-raised md:hidden"
        >
          {count > 0 ? `Filters (${count})` : "Filters"}
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        {toolbar}
      </div>
      <div
        id={panelId}
        className={cn(
          "mt-2 md:mt-0",
          contents ? "md:contents" : "md:block",
          open ? "block" : "hidden",
        )}
      >
        {children}
      </div>
    </div>
  );
}
