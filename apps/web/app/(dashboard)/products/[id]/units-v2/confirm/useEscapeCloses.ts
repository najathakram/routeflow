import * as React from "react";

type Entry = { close: () => void; opener: () => HTMLElement | null };

/** Open panels, oldest first: Escape only ever reaches the last one (V17). */
const stack: Entry[] = [];

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.preventDefault();
  top.close();
  top.opener()?.focus();
}

/**
 * Escape closes the topmost opened panel and returns focus to the control that opened it.
 * Call it from every panel with its own `open` flag; panels opened later sit on top, so with two
 * stacked panels the first Escape closes the newer one and the second closes the older one.
 * One document listener serves all panels and is attached only while one is open.
 */
export function useEscapeCloses(
  open: boolean,
  onClose: () => void,
  openerRef: React.RefObject<HTMLElement | null>,
): void {
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;

  React.useEffect(() => {
    if (!open) return;
    const entry: Entry = { close: () => closeRef.current(), opener: () => openerRef.current };
    if (stack.length === 0) document.addEventListener("keydown", onKeyDown);
    stack.push(entry);
    return () => {
      const at = stack.indexOf(entry);
      if (at >= 0) stack.splice(at, 1);
      if (stack.length === 0) document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, openerRef]);
}

/** RED SKELETON. */
export const hasOpenEscapePanel = (): boolean => false;
