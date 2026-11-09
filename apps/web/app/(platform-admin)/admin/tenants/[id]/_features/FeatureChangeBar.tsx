"use client";

import * as React from "react";
import { changeCountLabel } from "./useFeatureStage";

const PRIMARY =
  "rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400";
const QUIET =
  "rounded px-2 py-1 text-sm font-semibold text-slate-200 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400";

/** "3 changes · Review changes · Discard": shown while anything is staged; nothing is written until the sheet saves. */
export function FeatureChangeBar({
  count,
  onReview,
  onDiscard,
}: {
  count: number;
  onReview: () => void;
  onDiscard: () => void;
}) {
  if (count === 0) return null;
  return (
    <div
      role="region"
      aria-label="Staged changes"
      className="sticky bottom-2 z-20 mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-700 px-4 py-3 shadow-lg ring-1 ring-indigo-400/40"
    >
      <p className="text-sm text-white" data-testid="stage-count">
        {changeCountLabel(count)} <span className="text-slate-300">· not saved yet</span>
      </p>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onDiscard} className={QUIET}>
          Discard
        </button>
        <button type="button" onClick={onReview} className={PRIMARY}>
          Review changes
        </button>
      </div>
    </div>
  );
}

/** How long the Undo stays offered after a save. */
export const UNDO_WINDOW_MS = 10_000;

/** "Saved 3 changes. Undo": a status line that offers Undo for 10 seconds, then goes quiet. */
export function SavedToast({
  savedCount,
  undoing,
  error,
  onUndo,
  onDone,
}: {
  savedCount: number;
  undoing: boolean;
  error: string | null;
  onUndo: () => void;
  onDone: () => void;
}) {
  const doneRef = React.useRef(onDone);
  React.useEffect(() => {
    doneRef.current = onDone;
  });
  React.useEffect(() => {
    const t = setTimeout(() => doneRef.current(), UNDO_WINDOW_MS);
    return () => clearTimeout(t);
  }, []);
  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-xl bg-slate-800 px-4 py-3 text-sm text-white shadow-lg ring-1 ring-white/10"
    >
      <span>{error ?? `Saved ${changeCountLabel(savedCount)}.`}</span>
      {!error && (
        <button type="button" onClick={onUndo} disabled={undoing} className={QUIET}>
          {undoing ? "Undoing…" : "Undo"}
        </button>
      )}
    </div>
  );
}
