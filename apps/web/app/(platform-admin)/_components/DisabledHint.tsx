import * as React from "react";

/**
 * A control that is disabled for a reason the user cannot see says nothing to a keyboard or
 * screen-reader user (a disabled button is not focusable, and a `title` tooltip is mouse-only).
 * Render this next to it while the reason holds and point the control's `aria-describedby` at `id`
 * (A3 F8). Renders nothing when `show` is false, so the reference is only set while it resolves.
 */
export function DisabledHint({
  id,
  show,
  children,
  className = "text-xs text-slate-400",
}: {
  id: string;
  show: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  if (!show) return null;
  return (
    <p id={id} className={className}>
      {children}
    </p>
  );
}
