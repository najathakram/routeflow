"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { cn } from "@routeflow/ui/web";

/**
 * The phone card for a list row (below md), taken from the Orders list card (B823): number and
 * amount on top, the customer or supplier under it, badges, then a meta row. The card does no
 * money math: `amount` is a string the page already formatted with its own helper.
 *
 * `actions` sit in a footer row OUTSIDE the clickable link area, so a button is never nested in a
 * link and pressing one never opens the record.
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
  /** Row actions, rendered in a footer row outside the link. */
  actions?: React.ReactNode;
  urgent?: boolean;
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
  urgent,
}: RecordCardProps) {
  const router = useRouter();
  return (
    <li>
      <div
        data-record-card
        className={cn(
          "flex flex-col rounded-xl border border-surface-border bg-white shadow-card",
          urgent && "border-l-2 border-l-danger",
        )}
      >
        <div
          role="link"
          tabIndex={0}
          onClick={() => router.push(href)}
          onKeyDown={(e) => {
            if (e.key === "Enter") router.push(href);
          }}
          className="flex cursor-pointer flex-col gap-2 rounded-xl p-4 transition-colors hover:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-500"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              {urgent && <AlertTriangle className="h-4 w-4 shrink-0 text-danger" />}
              <span className="truncate font-mono text-xs font-semibold text-ink-900" title={title}>
                {title}
              </span>
            </div>
            <div className="flex shrink-0 flex-col items-end">
              {amountLabel && <span className="text-[11px] text-navy/60">{amountLabel}</span>}
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
          {meta != null && <div className="text-xs text-navy/60">{meta}</div>}
        </div>
        {actions != null && (
          <div className="flex items-center justify-end gap-2 border-t border-surface-border px-3 py-1.5">
            {actions}
          </div>
        )}
      </div>
    </li>
  );
}
