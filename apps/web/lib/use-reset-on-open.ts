import * as React from "react";

/**
 * Runs `reset(day)` each time a dialog OPENS, with the tenant's day when it is known by then ("" when not). It keys on
 * `open` alone: the tenant's day resolving later (a cold load) must not wipe what the operator has typed since, so the
 * day arrives through the caller's `useOnTenantToday` seed, which fills only an empty date.
 */
export function useResetOnOpen(
  open: boolean,
  today: string | undefined,
  reset: (day: string) => void,
): void {
  const todayRef = React.useRef(today);
  todayRef.current = today;
  const resetRef = React.useRef(reset);
  resetRef.current = reset;
  React.useEffect(() => {
    if (open) resetRef.current(todayRef.current ?? "");
  }, [open]);
}
