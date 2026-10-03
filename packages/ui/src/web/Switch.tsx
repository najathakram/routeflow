"use client";

import * as React from "react";
import { cn } from "./utils";
import { useReducedMotion } from "./motion";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Visible label; clicking it toggles. Provide this or `aria-labelledby`. */
  label?: React.ReactNode;
  "aria-labelledby"?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  "aria-labelledby": labelledBy,
  disabled,
  id,
  className,
}: SwitchProps) {
  const reduced = useReducedMotion();
  const autoId = React.useId();
  const labelId = label ? `${id ?? autoId}-label` : undefined;
  const toggle = () => {
    if (!disabled) onCheckedChange(!checked);
  };
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <button
        type="button"
        role="switch"
        id={id ?? autoId}
        aria-checked={checked}
        aria-labelledby={labelledBy ?? labelId}
        disabled={disabled}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            toggle();
          }
        }}
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
          "disabled:cursor-not-allowed disabled:opacity-50",
          checked ? "bg-brand-500" : "bg-navy/20",
          !reduced && "transition-colors",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "inline-block h-5 w-5 rounded-full bg-white shadow",
            checked ? "translate-x-[22px]" : "translate-x-0.5",
            !reduced && "transition-transform",
          )}
        />
      </button>
      {label ? (
        <span
          id={labelId}
          onClick={toggle}
          className={cn("text-sm text-navy", disabled ? "opacity-50" : "cursor-pointer")}
        >
          {label}
        </span>
      ) : null}
    </span>
  );
}
