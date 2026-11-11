"use client";

import * as React from "react";
import { ArrowDownAZ } from "lucide-react";

/**
 * W-1187 (SA ruling 7): "Sort A–Z" on a list of lines. One tap puts the lines in the order the invoice would print them
 * (the server's one comparator); the screen shows a toast with Undo. It only calls `onSort`: the order screen decides.
 * `saving`: a line-order save is in flight, so the button is off (a double click sends one request). 44 px tall at every
 * width: a tablet at 768 px is a finger too.
 */
export function SortLinesButton({
  onSort,
  saving = false,
}: {
  onSort: () => void;
  saving?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSort}
      disabled={saving}
      aria-busy={saving}
      className="inline-flex h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-navy/70 hover:bg-surface-raised hover:text-navy focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 disabled:opacity-60"
    >
      <ArrowDownAZ className="h-4 w-4" aria-hidden />
      Sort A–Z
    </button>
  );
}
