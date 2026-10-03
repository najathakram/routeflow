"use client";

import * as React from "react";
import { cn } from "./utils";

export interface ChipOption {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
}

export type ChipGroupProps = {
  options: ChipOption[];
  ariaLabel: string;
  className?: string;
} & (
  | { multiple?: false; value: string | null; onChange: (value: string) => void }
  | { multiple: true; value: string[]; onChange: (value: string[]) => void }
);

const chip = (on: boolean) =>
  cn(
    "inline-flex min-h-[36px] items-center rounded-full px-3 text-sm font-medium ring-1 ring-inset",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
    "disabled:cursor-not-allowed disabled:opacity-40",
    on
      ? "bg-brand-500 text-white ring-brand-500"
      : "bg-white text-navy ring-surface-border hover:bg-surface-raised",
  );

export function ChipGroup(props: ChipGroupProps) {
  const { options, ariaLabel, className } = props;
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);

  if (props.multiple) {
    const { value, onChange } = props;
    return (
      <div role="group" aria-label={ariaLabel} className={cn("flex flex-wrap gap-2", className)}>
        {options.map((o) => {
          const on = value.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              disabled={o.disabled}
              onClick={() =>
                onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])
              }
              className={chip(on)}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    );
  }

  const { value, onChange } = props;
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  const selectedIdx = options.findIndex((o) => o.value === value && !o.disabled);
  // Roving tabindex: the selected chip, else the first enabled one, is the single tab stop.
  const tabStop = selectedIdx >= 0 ? selectedIdx : (enabled[0] ?? -1);
  const move = (from: number, dir: 1 | -1) => {
    const pos = enabled.indexOf(from);
    const next = enabled[(pos + dir + enabled.length) % enabled.length];
    const target = next === undefined ? undefined : options[next];
    if (next === undefined || !target) return;
    refs.current[next]?.focus();
    onChange(target.value);
  };
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn("flex flex-wrap gap-2", className)}>
      {options.map((o, i) => {
        const on = i === selectedIdx;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={o.disabled}
            tabIndex={i === tabStop ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                move(i, 1);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                move(i, -1);
              }
            }}
            className={chip(on)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
