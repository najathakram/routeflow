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
        className="mt-5 max-sm:mt-3 flex min-h-[44px] w-full items-center justify-between border-t border-surface-border text-sm font-medium text-navy focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 sm:hidden"
      >
        More details
        <ChevronDown
          aria-hidden="true"
          className={cn("h-4 w-4 motion-safe:transition-transform", open && "rotate-180")}
        />
      </button>
      {/* Below sm the panel is a 0fr to 1fr grid row: a 200 ms height and opacity reveal (motion-safe only, so reduced
          motion is instant). Closed it is invisible, so its fields leave the Tab order but stay mounted. From sm up
          the row is always 1fr and fully opaque. */}
      <div
        id="details-more-panel"
        data-testid="details-more-panel"
        className={cn(
          "grid sm:grid-rows-[1fr] sm:opacity-100 motion-safe:transition-[grid-template-rows,opacity,visibility] motion-safe:duration-200 motion-safe:ease-out",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0 max-sm:invisible",
        )}
      >
        <div className="min-h-0 max-sm:-mx-1 max-sm:overflow-hidden max-sm:px-1">{children}</div>
      </div>
    </>
  );
}
