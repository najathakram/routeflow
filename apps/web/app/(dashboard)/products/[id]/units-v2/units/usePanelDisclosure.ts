import * as React from "react";

/** Shown next to every structural control while the price draft has unsaved changes. */
export const DIRTY_HINT = "Save or discard your price changes first";

/**
 * Open/close state for a panel and its opener (V15, V17): Escape closes the panel, and whichever way
 * it closes (Cancel, Escape, a finished action) focus goes back to the opener. A closed panel renders
 * nothing; the opener element stays mounted so focus has somewhere to land.
 */
export function usePanelDisclosure<T extends HTMLElement = HTMLButtonElement>() {
  const [open, setOpen] = React.useState(false);
  const openerRef = React.useRef<T>(null);
  const refocus = React.useRef(false);

  const close = React.useCallback(() => {
    refocus.current = true;
    setOpen(false);
  }, []);

  const toggle = React.useCallback(() => {
    if (open) close();
    else setOpen(true);
  }, [open, close]);

  // After the panel has gone and the opener is back on screen, hand focus to it.
  React.useEffect(() => {
    if (open || !refocus.current) return;
    refocus.current = false;
    openerRef.current?.focus();
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  return { open, setOpen, close, toggle, openerRef };
}
