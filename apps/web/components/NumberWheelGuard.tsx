"use client";

import * as React from "react";

/** True when the wheel's target is the number input that currently has focus. */
export function isFocusedNumberInput(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement &&
    target.type === "number" &&
    document.activeElement === target
  );
}

/**
 * Row 697 (F25): browsers step a FOCUSED <input type="number"> on mouse wheel, so a quantity or price changed with no
 * notice. One capture-phase listener for the whole app (mounted once in each shell): the wheel's default action is
 * cancelled while the target is the focused number input. Focus is kept (no blur); an unfocused input is untouched.
 */
export function NumberWheelGuard() {
  React.useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (isFocusedNumberInput(e.target)) e.preventDefault();
    };
    document.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => document.removeEventListener("wheel", onWheel, { capture: true });
  }, []);
  return null;
}
