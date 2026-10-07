"use client";

import * as React from "react";

/**
 * B1219: the one-item picker every scan surface shows for a single FUZZY match (no exact code).
 * The scan is never applied until the operator confirms; Cancel applies nothing.
 */
export function DidYouMeanPicker({
  name,
  confirmLabel = "Add",
  onConfirm,
  onCancel,
}: {
  name: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="group"
      aria-label="Did you mean"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-brand-300 bg-brand-50 px-3 py-2 text-sm text-navy"
    >
      <span className="min-w-0 flex-1 break-words">Did you mean {name}?</span>
      <button
        type="button"
        className="min-h-[44px] rounded bg-brand-600 px-3 text-sm font-medium text-white"
        onClick={onConfirm}
      >
        {confirmLabel}
      </button>
      <button
        type="button"
        className="min-h-[44px] rounded border border-surface-border bg-white px-3 text-sm text-navy"
        onClick={onCancel}
      >
        Cancel
      </button>
    </div>
  );
}
