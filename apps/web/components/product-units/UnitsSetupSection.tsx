"use client";

import * as React from "react";
import { Button } from "@routeflow/ui/web";

/** Digits go in their own spans so a number reads as a value (and never merges into a neighbour's text). */
function withNumbers(text: string) {
  return text.split(/(\d[\d,]*)/).map((part, i) =>
    /^\d/.test(part) ? (
      <span key={i} className="tabular-nums">
        {part}
      </span>
    ) : (
      <React.Fragment key={i}>{part}</React.Fragment>
    ),
  );
}

/**
 * The quiet collapsed row ("Sold in single pieces." + Set up units) and the region the ladder editor opens into.
 * The region always stays mounted so its height can animate (200ms ease-out, interruptible, instant for reduced
 * motion); the editor itself is only mounted while open.
 */
export function UnitsSetupSection({
  text,
  isSetUp,
  open,
  onToggle,
  regionId,
  children,
}: {
  text: string;
  isSetUp: boolean;
  open: boolean;
  onToggle: () => void;
  regionId: string;
  children?: React.ReactNode;
}) {
  return (
    <div data-testid="units-setup-section">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg bg-surface-raised px-3 py-2.5 text-sm">
        <p className="min-w-0 text-navy/80">{withNumbers(text)}</p>
        <Button
          size="sm"
          type="button"
          variant="secondary"
          aria-expanded={open}
          aria-controls={regionId}
          className="max-md:min-h-[44px]"
          onClick={onToggle}
        >
          {isSetUp ? "Edit units" : "Set up units"}
        </Button>
      </div>
      <div
        id={regionId}
        className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          {open ? <div className="p-1 pt-3">{children}</div> : null}
        </div>
      </div>
    </div>
  );
}
