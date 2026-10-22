"use client";

import { useEffect } from "react";

/**
 * Row 697: a browser steps a FOCUSED <input type="number"> on the mouse wheel (Edit Items qty 4 -> 3 or 5 pcs, so
 * $60.00 -> $61.50) with no sign: a silent money change. ONE capture-phase listener on the document, mounted once in
 * the app shell (app/providers.tsx), cancels the wheel for the focused number input, so every present and future
 * <input type="number"> is covered with no per-component wiring.
 *
 * Why this and not the alternatives:
 *  - not per-input `onWheel`/`blur()`: every new input (and every shared component) would have to remember it;
 *  - not `blur()` on wheel: it throws away the caret and the half-typed value the user is still editing;
 *  - capture + `passive: false` on `document`: runs before any component handler, and `preventDefault()` is honoured
 *    (React's own wheel handlers are passive).
 * An UNfocused number input does nothing on the wheel in browsers, so the page keeps scrolling over it; the
 * keyboard arrows still step a focused field on purpose; Ctrl+wheel (browser zoom) is left alone.
 */
export function blockFocusedNumberWheel(e: WheelEvent): void {
  if (e.ctrlKey) return;
  const el = e.target;
  if (
    el instanceof HTMLInputElement &&
    el.type === "number" &&
    el.ownerDocument.activeElement === el
  ) {
    e.preventDefault();
  }
}

/** Renders nothing; mount once in the app shell. */
export function NoWheelNumberInputs(): null {
  useEffect(() => {
    document.addEventListener("wheel", blockFocusedNumberWheel, { capture: true, passive: false });
    return () => document.removeEventListener("wheel", blockFocusedNumberWheel, { capture: true });
  }, []);
  return null;
}
