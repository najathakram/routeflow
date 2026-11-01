import * as React from "react";

const MARK = "__rfBackToClose";

let sheetsOpen = 0;
let ownPops = 0;

/**
 * True while a statement sheet is open, or while the history step it pushed is still being walked off. A `popstate` then
 * belongs to the sheet, so a page's own back guard (the counter's "Discard this sale?") must not treat it as the person
 * leaving the page.
 */
export function isSheetPop(): boolean {
  return sheetsOpen > 0 || ownPops > 0;
}

/**
 * SA-1078 U18: browser Back (or Android back) with a sheet open closes the sheet and stays on the page. Opening pushes one
 * history entry; a `popstate` while open closes. Closing any other way (X, Esc, backdrop) walks that entry off again, so the
 * next Back goes where the person expects. Same pattern as the edit-leave guard's sentinel entry.
 */
export function useBackToClose(open: boolean, onClose: () => void): void {
  const live = React.useRef(onClose);
  live.current = onClose;

  React.useEffect(() => {
    if (!open || typeof window === "undefined") return;
    window.history.pushState({ ...window.history.state, [MARK]: true }, "", window.location.href);
    sheetsOpen += 1;
    let pushed = true;
    const onPop = () => {
      pushed = false;
      live.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      sheetsOpen -= 1;
      if (pushed && window.history.state?.[MARK]) {
        // the walk back fires one popstate; page guards see it as the sheet's until it has landed
        ownPops += 1;
        window.addEventListener("popstate", () => window.setTimeout(() => (ownPops -= 1), 0), {
          once: true,
        });
        window.history.back();
      }
    };
  }, [open]);
}
