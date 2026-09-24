import * as React from "react";

/**
 * Focus management for an inline "confirm" swap: clicking a trigger button replaces it with a
 * confirm strip, so the clicked element unmounts and focus falls to <body> (A3 F9). Attach
 * `triggerRef` to the trigger and `confirmRef` to the confirm action: when `confirming` turns on,
 * focus moves to the confirm action; when it turns off again (cancel, or the action finished) focus
 * returns to the trigger. Nothing moves on the first render.
 */
export function useConfirmFocus(confirming: boolean) {
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const confirmRef = React.useRef<HTMLButtonElement>(null);
  const was = React.useRef(false);
  React.useEffect(() => {
    if (confirming) confirmRef.current?.focus();
    else if (was.current) triggerRef.current?.focus();
    was.current = confirming;
  }, [confirming]);
  return { triggerRef, confirmRef };
}
