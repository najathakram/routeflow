"use client";

import * as React from "react";
import { ArrowDownAZ } from "lucide-react";

/**
 * W-1187 (SA ruling 7): "Sort A–Z" on a list of lines. One tap puts the lines in the order the invoice would print them
 * (the server's one comparator); the screen shows a toast with Undo. It only calls `onSort`: the order screen decides.
 */
export function SortLinesButton({ onSort }: { onSort: () => void }) {
  return (
    <button
      type="button"
      onClick={onSort}
      className="inline-flex h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-navy/70 hover:bg-surface-raised hover:text-navy focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 md:h-9"
    >
      <ArrowDownAZ className="h-4 w-4" aria-hidden />
      Sort A–Z
    </button>
  );
}
