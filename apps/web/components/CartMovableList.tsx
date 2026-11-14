"use client";

import * as React from "react";
import { SortableLines, type LineMove, type SortableLine } from "@/components/SortableLines";

/**
 * W-1187 PR-2b: the `<ul>` of a cart (the order builder's list, the till's "Items") with the drag wrapper inside it, so a
 * screen swaps its own `<ul>` tag for this one and nothing else in its markup moves.
 */
export function CartMovableList({
  sortable,
  onMove,
  enabled,
  scanTarget,
  children,
  ...ul
}: {
  sortable: SortableLine[];
  onMove: (m: LineMove) => void;
  enabled: boolean;
  scanTarget?: () => HTMLElement | null;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLUListElement>, "children">) {
  return (
    <SortableLines lines={sortable} onMove={onMove} enabled={enabled} scanTarget={scanTarget}>
      <ul {...ul}>{children}</ul>
    </SortableLines>
  );
}
