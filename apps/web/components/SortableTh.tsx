"use client";

import * as React from "react";
import { ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import type { SortDirection } from "@/lib/use-sortable-data";

interface SortableThProps extends Omit<React.ThHTMLAttributes<HTMLTableCellElement>, "onClick"> {
  /** Stable identifier for this column — passed to `requestSort()`. */
  name: string;
  /** Currently active sort key (from `useSortableData`). */
  current: string | null;
  /** Currently active sort direction. */
  dir: SortDirection;
  /** Click handler from `useSortableData.requestSort`. */
  onSort: (name: string) => void;
  /** Set true for right-aligned numeric / currency columns. */
  align?: "left" | "right" | "center";
  children: React.ReactNode;
}

/**
 * Drop-in `<th>` for raw `<table>` markup that pairs with `useSortableData`.
 *
 *   <thead>
 *     <tr>
 *       <SortableTh name="name" current={sortKey} dir={sortDir} onSort={requestSort}>
 *         Product
 *       </SortableTh>
 *       <SortableTh name="currentStock" align="right" current={…} dir={…} onSort={…}>
 *         Stock
 *       </SortableTh>
 *     </tr>
 *   </thead>
 *
 * Behaviour:
 *   - Sort indicator is invisible by default (cleans up the header chrome).
 *   - Fades in when the operator hovers the column header.
 *   - Stays visible when the column is the active sort, with the arrow
 *     pointing in the current direction.
 *   - Click cycles asc → desc → unsorted (handled by `useSortableData`).
 */
export function SortableTh({
  name,
  current,
  dir,
  onSort,
  align = "left",
  className,
  children,
  ...rest
}: SortableThProps) {
  const isActive = current === name;
  return (
    <th
      {...rest}
      onClick={() => onSort(name)}
      aria-sort={isActive ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className={cn(
        "group cursor-pointer select-none transition-colors hover:text-navy",
        align === "right" && "text-right",
        align === "center" && "text-center",
        align === "left" && "text-left",
        className,
      )}
    >
      <span
        className={cn(
          "inline-flex items-center gap-1",
          align === "right" && "justify-end w-full",
          align === "center" && "justify-center w-full",
        )}
      >
        {children}
        <span
          className={cn(
            "text-navy/70 transition-opacity",
            isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
          aria-hidden="true"
        >
          {isActive ? (
            dir === "asc" ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )
          ) : (
            <ChevronsUpDown className="h-3.5 w-3.5" />
          )}
        </span>
      </span>
    </th>
  );
}
