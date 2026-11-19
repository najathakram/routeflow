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
export function RecordCardList({ children }: { children: React.ReactNode }) {
  return <ul className="space-y-3 md:hidden">{children}</ul>;
}

export interface RecordCardProps {
  /** Where the card opens. */
  href: string;
  /** The record number, shown in mono. */
  title: string;
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
}

export function RecordCard({
  href,
  title,
  amount,
  amountLabel,
  amountTone = "default",
  subtitle,
  badges,
  meta,
  actions,
}: RecordCardProps) {
  return (
    <li>
      <div
        data-record-card
        className="relative flex flex-col gap-1.5 rounded-xl border border-surface-border bg-white p-3 shadow-card transition-colors hover:bg-surface-raised"
      >
        <div className="flex items-start justify-between gap-3">
          <Link
            href={href}
            title={title}
            className="min-w-0 truncate font-mono text-xs font-semibold text-ink-900 after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-brand-500"
          >
            {title}
          </Link>
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
