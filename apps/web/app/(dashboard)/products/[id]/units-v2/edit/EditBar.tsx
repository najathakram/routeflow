"use client";

import * as React from "react";
import { EDIT_TESTIDS as E } from "./edit-testids";

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * V14: the ONE save bar (message left, Cancel then Save right), sticky to the bottom. V04: a labelled
 * region, a "Ctrl+S saves" hint and a Save that stays focusable (aria-disabled, not disabled) so the
 * skip link can always reach it. The bottom edge leaves the draft dock's band (bottom-24) clear.
 */
export function EditBar({
  count,
  problems,
  canSave,
  pending,
  onSave,
  onCancel,
}: {
  count: number;
  problems: string[];
  canSave: boolean;
  pending: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      data-testid={E.saveBar}
      className="sticky bottom-0 z-30 -mx-4 mt-4 border-t border-[#758380] bg-white/95 px-4 py-3 backdrop-blur"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 text-sm text-navy" aria-live="polite">
          {problems.length > 0 ? (
            <ul data-testid={E.problems} className="space-y-0.5 text-red-600">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : (
            <span>{count === 0 ? "Nothing changed yet" : `${count} unsaved`}</span>
          )}
          <span className="ml-2 text-xs text-navy/60">{isMac() ? "⌘S saves" : "Ctrl+S saves"}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid={E.cancel}
            onClick={onCancel}
            className="h-9 rounded-md border border-surface-border bg-white px-3 text-sm font-medium text-navy hover:bg-surface-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            id={E.save}
            data-testid={E.save}
            aria-disabled={!canSave}
            onClick={() => canSave && onSave()}
            className="h-9 rounded-md bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** V04: visually hidden until focused; moves focus to Save. */
export function SkipToSave() {
  return (
    <a
      href={`#${E.save}`}
      onClick={(e) => {
        e.preventDefault();
        document.getElementById(E.save)?.focus();
      }}
      className="absolute left-2 top-2 z-40 rounded bg-white px-3 py-1.5 text-sm font-medium text-navy shadow focus:not-sr-only [&:not(:focus)]:sr-only"
    >
      Skip to Save
    </a>
  );
}
