"use client";
import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@routeflow/ui/web";

/**
 * K11-23: below sm the secondary Details fields (MSRP, Description, Buyer merchandising) sit behind a "More details"
 * disclosure so the price region starts on the first phone screen. CSS breakpoints only: the trigger is `sm:hidden`
 * and the panel is hidden with `max-sm:hidden`, never unmounted, so a typed value survives collapse, rotation and
 * resize. Entering edit mode opens it (set during render, so the first edit frame is already open).
 */
export function DetailsMore({
  isEditing,
  children,
}: {
  isEditing: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(isEditing);
  const [wasEditing, setWasEditing] = React.useState(isEditing);
  if (isEditing !== wasEditing) {
    setWasEditing(isEditing);
    if (isEditing) setOpen(true);
  }
  return (
    <>
      <button
        type="button"
        data-testid="details-more-toggle"
        aria-expanded={open}
        aria-controls="details-more-panel"
        onClick={() => setOpen((o) => !o)}
        className="mt-5 flex min-h-[44px] w-full items-center justify-between rounded border border-surface-border px-3 text-sm font-medium text-navy sm:hidden"
      >
        More details
        <ChevronDown
          aria-hidden="true"
          className={cn("h-4 w-4 transition-transform", open && "rotate-180")}
        />
      </button>
      <div
        id="details-more-panel"
        data-testid="details-more-panel"
        className={cn(!open && "max-sm:hidden")}
      >
        {children}
      </div>
    </>
  );
}
