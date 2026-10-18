import * as React from "react";

type Entry = { close: () => void; opener: () => HTMLElement | null };

/** Open panels, oldest first: Escape only ever reaches the last one (V17). */
const stack: Entry[] = [];

/**
 * Close the topmost open panel and focus the control that opened it, exactly as its Escape does. Returns whether a panel
 * was open. K11-20: a host that handles Escape before this stack's own listener sees it (the floating price window:
 * Radix runs first and the window always takes the event) calls this when the panel is the next thing to close.
 */
export function closeTopEscapePanel(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close();
  top.opener()?.focus();
  return true;
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
  if (stack.length === 0) return;
  e.preventDefault();
  closeTopEscapePanel();
}

/** True while any panel using `useEscapeCloses` is open (a Radix Dialog host can skip its own Escape). */
export const hasOpenEscapePanel = (): boolean => stack.length > 0;

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
  const openerHolder = React.useRef(openerRef);
  closeRef.current = onClose;
  openerHolder.current = openerRef;

  React.useEffect(() => {
    if (!open) return;
    const entry: Entry = {
      close: () => closeRef.current(),
      opener: () => openerHolder.current.current,
    };
    if (stack.length === 0) document.addEventListener("keydown", onKeyDown);
    stack.push(entry);
    return () => {
      const at = stack.indexOf(entry);
      if (at >= 0) stack.splice(at, 1);
      if (stack.length === 0) document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
}
