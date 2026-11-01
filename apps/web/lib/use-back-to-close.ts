import * as React from "react";

const MARK = "__rfBackToClose";

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
    let pushed = true;
    const onPop = () => {
      pushed = false;
      live.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (pushed && window.history.state?.[MARK]) window.history.back();
    };
  }, [open]);
}
