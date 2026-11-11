"use client";

import * as React from "react";
import { useSortableLine } from "@/components/SortableLines";

/**
 * W-1187 PR-2b: what one cart row (the order builder's LineItemRow, the counter's CounterLineRow) takes from the drag
 * wrapper: the ref and style of its `<li>`, the handle in a slot at the row's leading edge, and the padding that makes room
 * for it. The slot is absolute and the handle is 24 px wide there, so it is fully visible at 390 and 768 (#4292: a handle
 * pulled out into the page margin was clipped by the scroll container). A row with no `moveId`, or one outside a movable
 * list (the scan screen), gets no handle and no change.
 */
export function useCartRowMove(moveId: string | undefined) {
  const { setNodeRef, style, handle } = useSortableLine(moveId ?? "");
  const on = !!moveId && !!handle;
  return {
    setNodeRef: on ? setNodeRef : undefined,
    style: on ? style : undefined,
    rowClass: on ? "relative pl-8" : "",
    slot: on ? (
      <div
        data-testid="line-move-slot"
        className="absolute inset-y-0 left-0 flex items-center [&>button]:ml-0 [&>button]:w-6"
      >
        {handle}
      </div>
    ) : null,
  };
}
