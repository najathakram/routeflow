"use client";

import * as React from "react";
import { useToast } from "@routeflow/ui/web";
import type { LineMove, SortableLine } from "@/components/SortableLines";
import { movedTitle, orderByIds } from "@/lib/cart-line-order";

/**
 * W-1187 PR-2b: the order builder's and the counter's line move. The cart is a local list until the sale is sent and its
 * array order is the order that is saved, so a move reorders the array (no request). It says "Moved X to line N" with
 * Undo for 6 s, one toast at a time (a new one replaces the old, whose Undo is void), and Ctrl/Cmd+Z takes the last move
 * back when focus is not in a text field (the same rule as the saved order's page). `afterMove` runs after a move and
 * after an Undo (the till hands focus back to the scan box there).
 */
const UNDO_MS = 6000;
const inTextField = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

export function useCartLineOrder<T>({
  lines,
  setLines,
  idOf,
  labelOf,
  enabled,
  afterMove,
  keyboardUndo = true,
}: {
  lines: readonly T[];
  setLines: React.Dispatch<React.SetStateAction<T[]>>;
  idOf: (l: T) => string;
  labelOf: (l: T) => string;
  enabled: boolean;
  /** Runs after a move and after an Undo, with the id of the line that moved. */
  afterMove?: (movedId: string) => void;
  /** Ctrl/Cmd+Z undoes the last move. False on the till: its ONE key listener is the scan one, so only the toast's Undo button there. */
  keyboardUndo?: boolean;
}) {
  const { toast, dismiss } = useToast();
  const toastId = React.useRef<string | null>(null);
  const undoTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastUndo = React.useRef<{ ids: string[]; movedId: string } | null>(null);
  const generation = React.useRef(0); // each toast owns its Undo: a replaced toast's button is void
  const linesRef = React.useRef(lines);
  linesRef.current = lines;
  const after = React.useRef(afterMove);
  after.current = afterMove;
  const canMove = enabled && lines.length > 1;

  const closeToast = React.useCallback(() => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = null;
    lastUndo.current = null;
    if (toastId.current) dismiss(toastId.current);
    toastId.current = null;
  }, [dismiss]);

  const undo = React.useCallback(() => {
    const last = lastUndo.current;
    if (!last) return;
    closeToast();
    setLines((cur) => orderByIds(cur, last.ids, idOf));
    after.current?.(last.movedId);
  }, [closeToast, idOf, setLines]);
  const undoNow = React.useRef(undo);
  undoNow.current = undo;

  const onMove = React.useCallback(
    ({ ids, movedId, toIndex }: LineMove) => {
      if (!canMove) return;
      const before = linesRef.current.map(idOf);
      const moved = linesRef.current.find((l) => idOf(l) === movedId);
      closeToast(); // one toast at a time: the old Undo is void
      const mine = ++generation.current;
      setLines((cur) => orderByIds(cur, ids, idOf));
      toastId.current = toast({
        title: movedTitle(moved ? labelOf(moved) : "Line", toIndex),
        variant: "success",
        duration: UNDO_MS,
        action: {
          label: "Undo",
          onClick: () => {
            if (generation.current === mine) undoNow.current();
          },
        },
      });
      lastUndo.current = { ids: before, movedId };
      // The toast pauses its own timer while hovered: close it with the Undo it offers, so a visible Undo always works.
      undoTimer.current = setTimeout(closeToast, UNDO_MS);
      after.current?.(movedId);
    },
    [canMove, closeToast, idOf, labelOf, setLines, toast],
  );

  React.useEffect(() => {
    if (!enabled || !keyboardUndo) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "z" || !(e.ctrlKey || e.metaKey) || e.shiftKey) return;
      if (inTextField(e.target) || !lastUndo.current) return;
      e.preventDefault();
      undoNow.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled, keyboardUndo]);

  // only on unmount (a re-render may hand back a new `dismiss`, and that must not close a live toast)
  const closeRef = React.useRef(closeToast);
  closeRef.current = closeToast;
  React.useEffect(() => () => closeRef.current(), []);

  const sortable: SortableLine[] = React.useMemo(
    () => lines.map((l) => ({ id: idOf(l), label: labelOf(l) })),
    [lines, idOf, labelOf],
  );
  return { sortable, onMove, enabled: canMove };
}
