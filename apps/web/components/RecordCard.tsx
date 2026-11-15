"use client";

import * as React from "react";
import Link from "next/link";
import { cn } from "@routeflow/ui/web";

/**
 * The phone card for a list row (below md), taken from the Orders list card (B823): number and
 * amount on top, the customer or supplier under it, badges, then a meta row. The card does no
 * money math: `amount` is a string the page already formatted with its own helper.
 *
 * The title is a real link stretched over the whole card (`after:absolute after:inset-0`), so tap,
 * long press and keyboard all work and no button is nested in a link. `actions` share the last
 * row with the meta line, lifted above the link (`relative z-10`), so pressing one never opens
 * the record.
 */
export function RecordCardList({
  children,
  className,
}: {
  children: React.ReactNode;
  /** For example bottom padding that keeps the last card above a fixed selection bar. */
  className?: string;
}) {
  return <ul className={cn("space-y-3 md:hidden", className)}>{children}</ul>;
}

export interface RecordCardProps {
  /** Where the card opens. */
  href: string;
  /** The record number (mono) or, with titleKind "name", a person or business name. */
  title: string;
  /** "number" (default) shows the title in mono text-xs; "name" in the normal text at text-sm, like the subtitle. */
  titleKind?: "number" | "name";
  /** Dims the whole card, like a dimmed table row (for example a void record). */
  dimmed?: boolean;
  /** A preformatted amount; the card never formats or sums. */
  amount: React.ReactNode;
  /** A small muted label for the amount, for example the table header's own word. */
  amountLabel?: string;
  /** Tone only; the page decides when it applies. */
  amountTone?: "default" | "danger";
  /** The customer or supplier. */
  subtitle?: React.ReactNode;
  /** Status badges and chips. */
  badges?: React.ReactNode;
  /** The meta row, for example the date. */
  meta?: React.ReactNode;
  /** Row actions, right aligned on the last row with the meta, above the stretched link. */
  actions?: React.ReactNode;
  /** Only for pages whose table selects rows for bulk actions: the checkbox shows when
   *  `onSelectedChange` is given. */
  selected?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  /** A record the bulk actions must skip: the checkbox shows disabled, with the reason as its title. */
  selectDisabled?: boolean;
  selectDisabledReason?: string;
  /** For a page whose table toggles the selection on a row tap while selecting: tapping the card
   *  toggles it instead of opening the record (a disabled card still opens). */
  tapToSelect?: boolean;
}

export function RecordCard({
  href,
  title,
  titleKind = "number",
  dimmed,
  amount,
  amountLabel,
  amountTone = "default",
  subtitle,
  badges,
  meta,
  actions,
  selected,
  onSelectedChange,
  selectDisabled,
  selectDisabledReason,
  tapToSelect,
}: RecordCardProps) {
  const titleLink = (
    <Link
      href={href}
      title={title}
      onClick={
        onSelectedChange && tapToSelect && !selectDisabled
          ? (e) => {
              e.preventDefault();
              onSelectedChange(!selected);
            }
          : undefined
      }
      className={cn(
        "min-w-0 truncate font-semibold text-ink-900 after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-brand-500",
        titleKind === "number" ? "font-mono text-xs" : "text-sm",
      )}
    >
      {title}
    </Link>
  );
  return (
    <li>
      <div
        data-record-card
        className={cn(
          "relative flex flex-col gap-1.5 rounded-xl border border-surface-border bg-white p-3 shadow-card transition-colors hover:bg-surface-raised",
          selected && "bg-brand-50",
          dimmed && "opacity-50",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          {onSelectedChange ? (
            <div className="flex min-w-0 items-center gap-2">
              {/* A 44x44 target that overlaps the card padding (-m-2.5), so the row stays as tall as the text. */}
              <label className="relative z-10 -m-2.5 grid h-11 w-11 shrink-0 cursor-pointer place-items-center">
                <input
                  type="checkbox"
                  aria-label={`Select ${title}`}
                  checked={selected ?? false}
                  disabled={selectDisabled}
                  title={selectDisabled ? selectDisabledReason : undefined}
                  onChange={(e) => onSelectedChange(e.target.checked)}
                  className="h-5 w-5 rounded border-surface-border text-brand-500 accent-brand-500"
                />
              </label>
              {titleLink}
            </div>
          ) : (
            titleLink
          )}
          <div className="flex shrink-0 flex-col items-end">
            {amountLabel && (
              <span className="text-[11px] leading-tight text-navy/60">{amountLabel}</span>
            )}
            <span
              className={cn(
                "font-mono text-sm font-semibold",
                amountTone === "danger" ? "text-danger" : "text-ink-900",
              )}
            >
              {amount}
            </span>
          </div>
        </div>
        {subtitle != null && (
          <p
            className="truncate text-sm font-medium text-navy"
            title={typeof subtitle === "string" ? subtitle : undefined}
          >
            {subtitle}
          </p>
        )}
        {badges != null && <div className="flex flex-wrap items-center gap-1.5">{badges}</div>}
        {(meta != null || actions != null) && (
          <div className="flex items-end justify-between gap-2">
            <div className="min-w-0 flex-1 text-xs text-navy/60">{meta}</div>
            {actions != null && (
              <div className="relative z-10 flex shrink-0 items-center justify-end gap-2">
                {actions}
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
