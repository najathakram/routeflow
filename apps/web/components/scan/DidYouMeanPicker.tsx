"use client";

import * as React from "react";

type Match = { id?: string; name?: string | null };

/**
 * B1219: the picker every scan surface shows when a scan had NO exact code match - one fuzzy hit
 * ("Did you mean <name>?") or several (every match listed, a confirm button per row). The scan is
 * never applied until the operator confirms a row; Cancel (or Escape) applies nothing.
 *
 * Focus deliberately STAYS in the scan input (nothing here autofocuses or traps focus): a USB wedge
 * scanner types its code and presses Enter into that input, so if this picker owned focus, the next
 * scan's Enter could press a confirm button and apply a guess nobody confirmed. With focus in the
 * input that Enter is just another scan. Escape is therefore listened for on the window, in the
 * capture phase, so it cancels the picker (and does not also dismiss the surrounding dialog).
 */
export function DidYouMeanPicker({
  matches,
  confirmLabel = "Add",
  onConfirm,
  onCancel,
}: {
  matches: Match[];
  confirmLabel?: string;
  onConfirm: (match: any) => void;
  onCancel: () => void;
}) {
  const cancelRef = React.useRef(onCancel);
  cancelRef.current = onCancel;
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      cancelRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const single = matches.length === 1;
  const nameOf = (m: Match) => String(m.name ?? "this item");
  return (
    <div
      role="group"
      aria-label="Did you mean"
      className="space-y-2 rounded-lg border border-brand-300 bg-brand-50 px-3 py-2 text-sm text-navy"
    >
      <div className="flex flex-wrap items-center gap-2">
        {/* A polite live region so a screen reader hears the prompt without moving focus. */}
        <span role="status" aria-live="polite" className="min-w-0 flex-1 break-words">
          {single ? `Did you mean ${nameOf(matches[0])}?` : "Did you mean one of these?"}
        </span>
        {single && (
          <button
            type="button"
            className="min-h-[44px] rounded bg-brand-600 px-3 text-sm font-medium text-white"
            onClick={() => onConfirm(matches[0])}
          >
            {confirmLabel}
          </button>
        )}
        <button
          type="button"
          className="min-h-[44px] rounded border border-surface-border bg-white px-3 text-sm text-navy"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
      {!single && (
        <ul className="space-y-1">
          {matches.map((m, i) => (
            <li key={m.id ?? i} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 break-words">{nameOf(m)}</span>
              <button
                type="button"
                aria-label={`${confirmLabel} ${nameOf(m)}`}
                className="min-h-[44px] rounded bg-brand-600 px-3 text-sm font-medium text-white"
                onClick={() => onConfirm(m)}
              >
                {confirmLabel}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
