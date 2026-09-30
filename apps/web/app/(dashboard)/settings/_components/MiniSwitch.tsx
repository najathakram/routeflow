"use client";

import * as React from "react";
import { cn } from "@routeflow/ui/web";

/**
 * Compact role="switch" toggle (MerchFlagToggle's idiom). `ariaDisabled` renders a muted,
 * focusable-but-inert switch (used for a channel that isn't set up yet, where the tooltip must
 * still be reachable); `disabled` is the hard native-disabled form.
 */
export function MiniSwitch({
  checked,
  disabled,
  ariaDisabled,
  title,
  description,
  onToggle,
  ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  ariaDisabled?: boolean;
  title?: string;
  /** Visible-to-AT description (a `title` alone is mouse-only). */
  description?: string;
  onToggle: () => void;
  ariaLabel: string;
}) {
  const descId = React.useId();
  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        aria-disabled={ariaDisabled ? true : undefined}
        title={title}
        aria-describedby={description ? descId : undefined}
        disabled={disabled}
        onClick={ariaDisabled ? undefined : onToggle}
        className={cn(
          "relative inline-flex h-5 w-9 flex-none items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          ariaDisabled && "cursor-not-allowed opacity-40",
          checked ? "bg-brand-500" : "bg-navy/20",
        )}
      >
        <span
          className={cn(
            "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-4" : "translate-x-0.5",
          )}
        />
      </button>
      {description && (
        <span id={descId} className="sr-only">
          {description}
        </span>
      )}
    </>
  );
}
