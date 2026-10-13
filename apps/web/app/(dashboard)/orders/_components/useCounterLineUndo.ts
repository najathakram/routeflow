"use client";

import * as React from "react";
import type { RemovedLine } from "./counter-sale-line-edit";

/** CQ-27: how long a removed line can be taken back. Long enough for a clerk who looks away to serve someone. */
export const LINE_UNDO_MS = 10_000;

/**
 * POS-3: a removed line is held for `LINE_UNDO_MS` in ONE slot (a newer removal makes the older one final). The countdown
 * PAUSES while the undo bar is hovered or focused and resumes with what was left only when BOTH the pointer and the keyboard
 * focus have left it. `hold` starts a window, `drop` ends it (and hands focus back to the scan field when the focused Undo
 * chip is about to vanish). `bar` is spread on the bar element.
 */
export function useCounterLineUndo(refocus: () => void) {
  const [undo, setUndo] = React.useState<RemovedLine | null>(null);
  const undoRef = React.useRef<RemovedLine | null>(null);
  undoRef.current = undo;
  const timerRef = React.useRef<number | null>(null);
  const hoverRef = React.useRef(false);
  const focusRef = React.useRef(false);
  const leftRef = React.useRef(LINE_UNDO_MS);
  const startedRef = React.useRef(0);

  const drop = React.useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    leftRef.current = LINE_UNDO_MS;
    const hadFocus = focusRef.current;
    focusRef.current = false; // the focused Undo button is gone with the line; the pointer may still be over the bar
    setUndo(null);
    if (hadFocus) refocus(); // the focused Undo chip vanished: the cursor goes back to the scan field, not <body>
  }, [refocus]);

  const arm = (ms: number) => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    leftRef.current = ms;
    if (hoverRef.current || focusRef.current) return; // held: the leave/blur handler starts the countdown
    startedRef.current = Date.now();
    timerRef.current = window.setTimeout(drop, ms);
  };
  const pause = () => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
    leftRef.current = Math.max(0, leftRef.current - (Date.now() - startedRef.current));
  };
  const resume = () => {
    if (!undoRef.current || timerRef.current !== null) return;
    arm(leftRef.current);
  };
  React.useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const hold = (removed: RemovedLine) => {
    setUndo(removed);
    arm(LINE_UNDO_MS);
  };

  const bar = {
    onMouseEnter: () => {
      hoverRef.current = true;
      pause();
    },
    onMouseLeave: () => {
      hoverRef.current = false;
      if (!focusRef.current) resume();
    },
    onFocus: () => {
      focusRef.current = true;
      pause();
    },
    onBlur: (e: React.FocusEvent<HTMLElement>) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return; // focus moved within the bar
      focusRef.current = false;
      if (!hoverRef.current) resume();
    },
  };

  return { undo, hold, drop, bar };
}
