"use client";

import * as React from "react";
import { useSortableLine } from "@/components/SortableLines";

/**
 * W-1187: a table row that can be dragged to a new place, for screens whose rows are written inline (the buyer's order
 * page). `<LineRow movable>` is a sortable `<tr>` that hands its move handle to the cell that draws `<LineHandle />`;
 * `<LineRow>` without `movable` is a plain `<tr>` and `<LineHandle />` draws nothing. Needs a `SortableLines` above it
 * only when movable.
 */
const HandleSlot = React.createContext<React.ReactNode>(null);

function SortableTr({
  id,
  className,
  children,
}: {
  id: string;
  className?: string;
  children: React.ReactNode;
}) {
  const { setNodeRef, style, handle } = useSortableLine(id);
  return (
    <tr ref={setNodeRef} style={style} className={className}>
      <HandleSlot.Provider value={handle}>{children}</HandleSlot.Provider>
    </tr>
  );
}

export function LineRow({
  id,
  movable,
  className,
  children,
}: {
  id: string;
  movable: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return movable ? (
    <SortableTr id={id} className={className}>
      {children}
    </SortableTr>
  ) : (
    <tr className={className}>{children}</tr>
  );
}

/** The row's handle, drawn in the cell's own left padding (24 px wide, full row tall), so the table gains no width. */
export function LineHandle() {
  const handle = React.useContext(HandleSlot);
  if (!handle) return null;
  return (
    <div
      className="absolute inset-y-0 left-0 flex items-center [&>button]:w-6"
      data-testid="row-handle-slot"
    >
      {handle}
    </div>
  );
}
