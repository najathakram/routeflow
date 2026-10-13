"use client";

import * as React from "react";
import { Button, TAP_TARGET, cn } from "@routeflow/ui/web";
import { parkedAgo } from "@/lib/drafts";
import { countNoun } from "@/lib/plural";
import type { InvoiceDraftSnapshot } from "@/lib/invoice-draft-storage";

/** ROW 447: fixed copy. Nothing here is server text. */
export const DRAFT_BANNER_TITLE = "Restore unsaved invoice?";
export const DRAFT_BANNER_LABEL = "Unsaved invoice";
/** The same fixed labels the form headings use. */
export const DRAFT_KIND_LABEL = { newSale: "New sale", standalone: "Other charge" } as const;
export const DRAFT_RESTORED_COPY = "Draft restored.";
export const DRAFT_BANNER_WARNING = "Starting a new invoice discards the saved draft.";

export function draftNoticeCopy(
  droppedLines: number,
  customerCleared: boolean,
  pricesUpdated = 0,
): string | null {
  const parts: string[] = [];
  if (droppedLines === 1) parts.push("1 item is no longer in your catalog and was left out.");
  else if (droppedLines > 1)
    parts.push(`${droppedLines} items are no longer in your catalog and were left out.`);
  if (customerCleared) parts.push("The customer is no longer available. Choose one to continue.");
  if (pricesUpdated === 1) parts.push("1 price updated.");
  else if (pricesUpdated > 1) parts.push(`${pricesUpdated} prices updated.`);
  return parts.length ? parts.join(" ") : null;
}

/** "Acme Co · 2 items · saved 5 min ago" */
export function draftSummary(snapshot: InvoiceDraftSnapshot, savedAt: number): string {
  const filled = snapshot.lines.filter((l) => l.productId || l.description.trim()).length;
  return [
    DRAFT_KIND_LABEL[snapshot.basis],
    snapshot.customer?.businessName || null,
    countNoun(filled, "item"),
    `saved ${parkedAgo(new Date(savedAt).toISOString())}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Calm, non-modal, one sentence and two actions. It never takes focus; the status line is announced politely.
 * `notice` (after a restore dropped something) replaces the offer with a one-line, dismissible note.
 */
export function InvoiceDraftBanner({
  summary,
  notice,
  restored,
  warning,
  busy,
  onRestore,
  onDiscard,
  onDismissNotice,
}: {
  summary: string | null;
  notice: string | null;
  /** The draft was just restored: say so, politely. */
  restored: boolean;
  /** A fresh form is being edited while the offer is open: saving it will discard the stored draft. */
  warning: boolean;
  busy: boolean;
  onRestore: () => void;
  onDiscard: () => void;
  onDismissNotice: () => void;
}) {
  if (!summary && !notice && !restored) return null;
  return (
    <section
      aria-label={DRAFT_BANNER_LABEL}
      className="flex flex-col gap-3 rounded-xl border border-surface-border bg-white p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div role="status" aria-live="polite" className="min-w-0">
        {summary ? (
          <>
            <p className="text-sm font-semibold text-navy">{DRAFT_BANNER_TITLE}</p>
            <p className="text-sm text-navy/70">{summary}</p>
            {warning ? <p className="text-sm text-navy/70">{DRAFT_BANNER_WARNING}</p> : null}
          </>
        ) : (
          <>
            {restored ? <p className="text-sm text-navy/70">{DRAFT_RESTORED_COPY}</p> : null}
            {notice ? <p className="text-sm text-navy/70">{notice}</p> : null}
          </>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        {summary ? (
          <>
            <Button
              size="sm"
              className={cn(TAP_TARGET)}
              onClick={onRestore}
              loading={busy}
              disabled={busy}
            >
              Restore
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className={cn(TAP_TARGET)}
              onClick={onDiscard}
              disabled={busy}
            >
              Discard
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            className={cn(TAP_TARGET)}
            onClick={onDismissNotice}
          >
            Dismiss
          </Button>
        )}
      </div>
    </section>
  );
}
