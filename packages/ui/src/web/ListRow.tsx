"use client";

import * as React from "react";
import { cn } from "./utils";

export interface ListRowProps {
  leading?: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  trailing?: React.ReactNode;
  /** Inset divider (starts after the leading slot). Never drawn under the last row. Default true. */
  inset?: boolean;
  as?: "li" | "div";
  /** Makes the whole row a button. Do not put another control in `trailing` when set. */
  onActivate?: () => void;
  selected?: boolean;
  className?: string;
}

export function ListRow({
  leading,
  title,
  meta,
  trailing,
  inset = true,
  as: Tag = "li",
  onActivate,
  selected,
  className,
}: ListRowProps) {
  const body = (
    <>
      {leading ? <span className="shrink-0">{leading}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-navy">{title}</span>
        {meta ? <span className="block truncate text-xs text-navy/60">{meta}</span> : null}
      </span>
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
    </>
  );
  const inner = "flex min-h-[44px] w-full items-center gap-3 px-3 py-2 text-left";
  return (
    <Tag
      data-selected={selected ? "true" : undefined}
      className={cn(
        "relative",
        selected && "bg-brand-50",
        // The divider sits under the row, inset past the leading slot; none under the last row.
        "after:absolute after:bottom-0 after:right-0 after:h-px after:bg-surface-border last:after:hidden",
        inset ? "after:left-3" : "after:left-0",
        className,
      )}
    >
      {onActivate ? (
        <button
          type="button"
          onClick={onActivate}
          aria-pressed={selected === undefined ? undefined : selected}
          className={cn(
            inner,
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500",
          )}
        >
          {body}
        </button>
      ) : (
        <div className={inner}>{body}</div>
      )}
    </Tag>
  );
}
